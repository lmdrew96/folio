"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useConvex, useMutation, useQuery } from "convex/react";
import { ConvexClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { useTheme } from "next-themes";
import * as Y from "yjs";
import { yUndoPluginKey } from "y-prosemirror";
import { withCollaboration, YUndoExtension } from "@blocknote/core/yjs";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { folioSchema, FolioFormattingToolbar } from "@/blocknote/schema";
import { attachConvexSync, type SyncHandle } from "@/lib/convexProvider";
import { registerPendingSaveFlush } from "@/lib/pendingSave";
import { fontCssValue } from "@/lib/fonts";
import { exportBlockNote, type ExportFormat } from "@/lib/export";
import {
  blockPlainText,
  selectionText,
  toTipTapDoc,
  flatten,
  rowsToBlocks,
  toRows,
  type BnBlock,
} from "@/blocknote/rows";
import {
  attributionExtension,
  setAttribution,
  smartTypographyExtension,
  undoSelectionExtension,
  type BlockAttribution,
} from "@/blocknote/extensions";
import { countWords, EditorToolbar, OutlineRail, type OutlineHeading } from "./EditorToolbar";

/** Where BlockNote keeps the document inside its Y.Doc. */
const FRAGMENT = "blocknote";
/** Quiet time after an edit before the derived block rows are rebuilt. */
const EXTRACT_DEBOUNCE_MS = 1000;
/** How long to wait before re-claiming a room another tab is still creating. */
const CLAIM_RETRY_MS = 2000;
/** Longest the update toast waits for edits to finish saving. */
const SAVE_WAIT_MS = 30_000;
/** Whether the outline rail beside the page is shown (per device). */
const OUTLINE_KEY = "folio:outline:visible";

type Connection = "connecting" | "synced" | "degraded" | "failed";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const codeOf = (e: unknown) =>
  e instanceof ConvexError ? (e.data as { code?: string } | undefined)?.code : undefined;

/**
 * A document edited in BlockNote. Its Y.Doc lives in Convex (convex/ydoc.ts,
 * `space: "blocknote"`), synced on the page by src/lib/convexProvider.ts.
 * This component also:
 *   - rebuilds the derived `blocks` rows after local edits settle, keyed by
 *     BlockNote's own block ids, so the diff panel, attribution, Cleo and the
 *     MCP door keep working,
 *   - tells the writer when edits aren't reaching the server, and guards
 *     unload until they have.
 * Key it on documentId: the Y.Doc and editor are made once per document.
 */
export function BlockNoteEditor({ documentId }: { documentId: Id<"documents"> }) {
  const { getToken } = useAuth();
  const { resolvedTheme } = useTheme();
  const convex = useConvex();
  const claimRoom = useMutation(api.ydoc.claimRoom);
  const reconcile = useMutation(api.blocks.reconcile);
  const meta = useQuery(api.documents.get, { documentId });

  const [ydoc] = useState(() => new Y.Doc());
  const [claimToken] = useState(() => crypto.randomUUID());
  const editor = useCreateBlockNote(
    withCollaboration({
      schema: folioSchema,
      extensions: [smartTypographyExtension, attributionExtension, undoSelectionExtension],
      collaboration: {
        fragment: ydoc.getXmlFragment(FRAGMENT),
        // No cursors are shared yet; the name is required.
        user: { name: "Folio", color: "" },
      },
    }),
    [ydoc],
  );

  // y-prosemirror destroys its undo manager when the editor view unmounts,
  // but the editor keeps the dead one — so a remount (StrictMode does one in
  // dev) leaves undo doing nothing. Re-add the plugin when that happens
  // (NugNotes notes-editor.tsx).
  useEffect(() => {
    const undoManager = yUndoPluginKey.getState(editor.prosemirrorState)?.undoManager;
    if (undoManager && !undoManager.trackedOrigins.has(undoManager)) {
      editor.unregisterExtension("yUndo");
      editor.registerExtension(YUndoExtension());
    }
  });

  // ---- connection + save state ----
  const [connection, setConnection] = useState<Connection>("connecting");
  const connectionRef = useRef<Connection>("connecting");
  const unpushed = useRef(false);
  const synced = useRef(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const unsynced = connection === "degraded" || connection === "failed";

  const waitUntilSaved = useCallback(async (): Promise<boolean> => {
    const deadline = Date.now() + SAVE_WAIT_MS;
    while (unpushed.current) {
      if (Date.now() > deadline) return false;
      await sleep(100);
    }
    return true;
  }, []);

  // ---- live view of the document (word count, outline, attribution) ----
  const [liveBlocks, setLiveBlocks] = useState<BnBlock[]>([]);
  const [selectedWordCount, setSelectedWordCount] = useState(0);

  // ---- derived block rows ----
  const extractTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const extracting = useRef<Promise<void> | null>(null);
  const extractAgain = useRef(false);

  const extract = useCallback(async (): Promise<void> => {
    // Before the first sync the editor is empty; writing that would wipe the rows.
    if (!synced.current) return;
    if (extracting.current) {
      extractAgain.current = true; // an edit landed mid-run; go once more after
      return extracting.current;
    }
    extracting.current = (async () => {
      do {
        extractAgain.current = false;
        try {
          await reconcile({
            documentId,
            blocks: toRows(editor.document as unknown as BnBlock[]),
            source: "blocknote",
          });
        } catch (e) {
          // The Y.Doc (the real content) is unaffected; the rows catch up on
          // the next edit. Logged, not surfaced — nothing the writer can do.
          const code = codeOf(e);
          console.error(`Folio: block extraction failed${code ? ` (${code})` : ""}`, e);
        }
      } while (extractAgain.current);
    })();
    try {
      await extracting.current;
    } finally {
      extracting.current = null;
    }
  }, [documentId, editor, reconcile]);

  const scheduleExtract = useCallback(() => {
    clearTimeout(extractTimer.current);
    extractTimer.current = setTimeout(() => void extract(), EXTRACT_DEBOUNCE_MS);
  }, [extract]);

  // Local edits rebuild the rows; every change (a collaborator's too)
  // refreshes the live view. Remote edits are their writer's to reconcile,
  // or they'd be attributed to whoever happened to have the tab open.
  useEffect(() => {
    let viewTimer: ReturnType<typeof setTimeout> | undefined;
    const offLocal = editor.onChange(() => scheduleExtract(), false);
    const offAll = editor.onChange(() => {
      clearTimeout(viewTimer);
      viewTimer = setTimeout(() => setLiveBlocks(editor.document as unknown as BnBlock[]), 300);
    });
    const offSelection = editor.onSelectionChange(() =>
      setSelectedWordCount(
        countWords(editor.transact((tr) => selectionText(tr.doc, tr.selection.from, tr.selection.to))),
      ),
    );
    return () => {
      clearTimeout(viewTimer);
      offLocal();
      offAll();
      offSelection();
    };
  }, [editor, scheduleExtract]);

  // ---- open: claim the room, then sync ----
  const fetchToken = useCallback(async () => (await getToken({ template: "convex" })) ?? null, [getToken]);

  useEffect(() => {
    let cancelled = false;
    let sync: SyncHandle | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const setState = (state: Connection) => {
      console.debug(`Folio: BlockNote sync ${connectionRef.current} → ${state}`);
      connectionRef.current = state;
      setConnection(state);
    };
    const open = async () => {
      try {
        const mode = await claimRoom({ documentId, claimToken, space: "blocknote" });
        if (cancelled) return;
        if (mode === "wait") {
          timer = setTimeout(() => void open(), CLAIM_RETRY_MS);
          return;
        }
        // A BlockNote document with rows but no Y.Doc yet was written
        // server-side (a review sheet, documents.createReviewSheet): its first
        // opener builds the Y.Doc from them. Fetched before syncing so it's
        // in place before anything can be typed or extracted.
        const seed =
          mode === "create"
            ? await convex.query(api.blocks.list, { documentId })
            : [];
        if (cancelled) return;
        const client = new ConvexClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
        client.setAuth(fetchToken);
        sync = attachConvexSync({
          client,
          documentId,
          space: "blocknote",
          ydoc,
          callbacks: {
            onSynced: () => {
              setState("synced");
              if (synced.current) return;
              synced.current = true;
              if (seed.length && ydoc.getXmlFragment(FRAGMENT).length === 0) {
                // Block ids are kept, so the extraction this triggers leaves
                // the rows (and their author) as they are.
                editor.replaceBlocks(editor.document, rowsToBlocks(seed) as Parameters<typeof editor.replaceBlocks>[1]);
              }
              setLiveBlocks(editor.document as unknown as BnBlock[]);
            },
            onDegraded: () => setState("degraded"),
            onFailed: (detail) => {
              console.error("Folio: BlockNote sync failed", detail);
              setState("failed");
            },
          },
          onSaveStatus: ({ unpushed: u }) => {
            unpushed.current = u;
          },
        });
      } catch (e) {
        console.error("Folio: couldn't open the BlockNote room", e);
        if (!cancelled) setOpenError("This document couldn't be opened.");
      }
    };
    void open();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      // Sends any edits still waiting before closing the connection.
      void sync?.destroy();
    };
  }, [claimRoom, claimToken, convex, documentId, editor, fetchToken, ydoc]);

  // Closing or reloading the tab can't wait for a save, so it asks instead.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!unpushed.current && connectionRef.current !== "degraded" && connectionRef.current !== "failed") return;
      e.preventDefault();
      e.returnValue = ""; // some browsers still require this to show the prompt
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // The update toast flushes through here before reloading.
  useEffect(
    () =>
      registerPendingSaveFlush(async () => {
        clearTimeout(extractTimer.current);
        const [saved] = await Promise.all([waitUntilSaved(), extract()]);
        return saved && connectionRef.current !== "degraded" && connectionRef.current !== "failed";
      }),
    [extract, waitUntilSaved],
  );

  useEffect(
    () => () => {
      // Leaving the document: rebuild the rows one last time.
      if (extractTimer.current) {
        clearTimeout(extractTimer.current);
        void extract();
      }
    },
    [extract],
  );

  // ---- attribution: block rows (who/when) → the editor's ticks ----
  const rows = useQuery(api.blocks.list, { documentId });
  useEffect(() => {
    if (!rows) return;
    const map = new Map<string, BlockAttribution>();
    for (const r of rows) {
      map.set(r.blockId, {
        author: r.author ?? "",
        name: r.author === "claude" ? "Cleo" : (r.authorName ?? "Nae"),
        lastEditedAt: r.lastEditedAt,
      });
    }
    try {
      setAttribution(editor, map);
    } catch (e) {
      // Only before the view mounts; the next rows update carries it.
      console.debug("Folio: attribution not applied yet", e);
    }
  }, [editor, rows]);

  // ---- toolbar: word count + outline ----
  const [outlineOpen, setOutlineOpen] = useState(() => {
    try {
      return localStorage.getItem(OUTLINE_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toggleOutline = () =>
    setOutlineOpen((prev) => {
      try {
        localStorage.setItem(OUTLINE_KEY, prev ? "0" : "1");
      } catch {
        // not persisted; still toggles for this session
      }
      return !prev;
    });
  const all = useMemo(() => flatten(liveBlocks), [liveBlocks]);
  const wordCount = useMemo(() => all.reduce((n, b) => n + countWords(blockPlainText(b)), 0), [all]);
  const headings = useMemo<OutlineHeading[]>(
    () =>
      all
        .filter((b) => b.type === "heading")
        .map((b) => ({ nodeId: b.id, level: Number(b.props.level) || 1, text: blockPlainText(b).trim() })),
    [all],
  );
  const jumpTo = (id: string) => {
    document.querySelector(`.bn-block[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center" });
    editor.setTextCursorPosition(id, "start");
    editor.focus();
  };

  // The blank paper below the last line is still the page: a click there
  // puts the cursor at the end, like a word processor.
  const focusEndOnBlankPaper = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only the sheet itself — not a menu or toolbar BlockNote opens on it,
    // which can sit below the last line of a short document.
    if (e.target !== e.currentTarget) return;
    const content = e.currentTarget.querySelector(".bn-editor");
    if (!content || e.clientY <= content.getBoundingClientRect().bottom) return;
    const last = editor.document.at(-1);
    if (!last) return;
    e.preventDefault(); // keep the focus the editor is about to get
    editor.setTextCursorPosition(last, "end");
    editor.focus();
  };

  if (openError) return <p className="px-6 py-10 text-muted">{openError}</p>;

  return (
    <div className="folio-blocknote relative flex min-h-0 flex-1 flex-col">
      <EditorToolbar
        editor={editor}
        documentId={documentId}
        editable
        wordCount={wordCount}
        selectedWordCount={selectedWordCount}
        outlineOpen={outlineOpen}
        onToggleOutline={toggleOutline}
        onExport={(format: ExportFormat) => {
          const blocks = editor.document as unknown as BnBlock[];
          return exportBlockNote(toTipTapDoc(blocks), editor.blocksToHTMLLossy(), meta?.title || "Untitled", format);
        }}
      />
      {/* A column, so the sheet (flex-1) reaches the bottom of the view even
          when the text is short, and grows with it when it's long. The outline
          rail sits beside it on wider screens, above it on a phone. */}
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto pt-6 sm:pt-10 md:flex-row md:px-6">
        {outlineOpen && <OutlineRail headings={headings} onJump={jumpTo} />}
        <div
          className="folio-paper mx-auto mb-6 w-full max-w-3xl flex-1 cursor-text sm:mb-10"
          style={{ "--folio-prose-font": fontCssValue(meta?.fontFamily) } as React.CSSProperties}
          onMouseDown={focusEndOnBlankPaper}
        >
          <BlockNoteView
            editor={editor}
            theme={resolvedTheme === "dark" ? "dark" : "light"}
            formattingToolbar={false}
          >
            <FolioFormattingToolbar />
          </BlockNoteView>
        </div>
      </div>
      {/* A quiet pill when edits aren't reaching the server. */}
      <div
        className={`absolute bottom-5 left-1/2 z-20 flex print:hidden -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-3 py-1 text-xs text-foreground shadow-sm transition-opacity duration-200 ${
          unsynced ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <span aria-live="polite">
          {connection === "failed" ? "Not saved — this document can't sync right now" : "Not saved — reconnecting…"}
        </span>
      </div>
    </div>
  );
}
