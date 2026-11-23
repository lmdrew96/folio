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
import { blockText } from "@convex/blockMarkdown";
import { folioSchema, FolioFormattingToolbar } from "@/blocknote/schema";
import { attachConvexSync, type SyncHandle } from "@/superdoc/convexProvider";
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
import { countWords, SuperDocFooter, type OutlineHeading } from "./SuperDocFooter";

/** Where BlockNote keeps the document inside its Y.Doc. */
const FRAGMENT = "blocknote";
/** Quiet time after an edit before the derived block rows are rebuilt. */
const EXTRACT_DEBOUNCE_MS = 1000;
/** How long to wait before re-claiming a room another tab is still creating. */
const CLAIM_RETRY_MS = 2000;
/** How often to check back while another tab converts this document. */
const BUSY_RETRY_MS = 5000;
/** Longest a save-dependent step (conversion, the update toast) waits. */
const SAVE_WAIT_MS = 30_000;

type Connection = "connecting" | "synced" | "degraded" | "failed";
/** Moving a SuperDoc document onto BlockNote. */
type Phase = "none" | "busy" | "converting" | "failed";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const codeOf = (e: unknown) =>
  e instanceof ConvexError ? (e.data as { code?: string } | undefined)?.code : undefined;

/**
 * A document edited in BlockNote. Its Y.Doc lives in Convex (convex/ydoc.ts,
 * `space: "blocknote"`), synced on the page by the same provider SuperDoc's
 * worker uses. This component also:
 *   - converts a SuperDoc document on open (`convert`), keeping block ids,
 *   - rebuilds the derived `blocks` rows after local edits settle, keyed by
 *     BlockNote's own block ids, so the diff panel, attribution, Cleo and the
 *     MCP door keep working,
 *   - tells the writer when edits aren't reaching the server, and guards
 *     unload until they have.
 * Key it on documentId: the Y.Doc and editor are made once per document.
 */
export function BlockNoteEditor({
  documentId,
  convert = false,
}: {
  documentId: Id<"documents">;
  /** The document is still on SuperDoc: move it to BlockNote on open. */
  convert?: boolean;
}) {
  const { getToken } = useAuth();
  const { resolvedTheme } = useTheme();
  const convex = useConvex();
  const claimRoom = useMutation(api.ydoc.claimRoom);
  const reconcile = useMutation(api.blocks.reconcile);
  const prepareBlockNote = useMutation(api.conversion.prepareBlockNote);
  const finishBlockNote = useMutation(api.conversion.finishBlockNote);
  const failBlockNote = useMutation(api.conversion.failBlockNote);
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
  // True until this document is on BlockNote; extraction stays off meanwhile
  // (the block rows still belong to SuperDoc).
  const converting = useRef(convert);
  const [phase, setPhase] = useState<Phase>(convert ? "converting" : "none");
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
    if (!synced.current || converting.current) return;
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

  // ---- converting from SuperDoc ----
  const convertNow = useCallback(async () => {
    const giveUp = async (reason: string) => {
      console.error(`Folio: couldn't move this document to BlockNote — ${reason}`);
      setPhase("failed");
      try {
        await failBlockNote({ documentId, reason });
      } catch (e) {
        console.error("Folio: couldn't record the failed conversion", e);
      }
    };
    try {
      // updatedAt first: if a SuperDoc tab saves after this, finish refuses.
      const doc = await convex.query(api.documents.get, { documentId });
      const rows = await convex.query(api.blocks.list, { documentId });
      if (!doc) return await giveUp("the document is unavailable");

      if (ydoc.getXmlFragment(FRAGMENT).length === 0) {
        const blocks = rowsToBlocks(rows);
        // replaceBlocks' types are the schema's; these are plain partial blocks.
        editor.replaceBlocks(
          editor.document,
          (blocks.length ? blocks : [{ type: "paragraph" }]) as Parameters<typeof editor.replaceBlocks>[1],
        );
      }

      // Text check: every word, in order, and every row's id still here.
      const converted = toRows(editor.document as unknown as BnBlock[]);
      const textOf = (r: { content: unknown }) =>
        blockText(typeof r.content === "string" ? JSON.parse(r.content) : r.content);
      const before = squash(rows.map(textOf).join(" "));
      const after = squash(converted.map(textOf).join(" "));
      if (before !== after) return await giveUp("text check: the converted text differs");
      const ids = new Set(converted.map((r) => r.blockId));
      const lost = rows.find((r) => textOf(r) !== "" && !ids.has(r.blockId));
      if (lost) return await giveUp(`block ${lost.blockId} lost its id`);

      if (!(await waitUntilSaved())) return await giveUp("the converted document didn't finish saving");
      const head = await convex.query(api.ydoc.head, { documentId, space: "blocknote" });
      if (!head?.count) return await giveUp("the converted document never reached the server");

      await finishBlockNote({ documentId, basedOn: doc.updatedAt, blocks: converted });
      converting.current = false;
      setPhase("none");
    } catch (e) {
      await giveUp(codeOf(e) ?? (e instanceof Error ? e.message : String(e)));
    }
  }, [convex, documentId, editor, failBlockNote, finishBlockNote, waitUntilSaved, ydoc]);

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
        if (converting.current) {
          const state = await prepareBlockNote({ documentId, claimToken });
          if (cancelled) return;
          if (state === "busy") {
            setPhase("busy");
            timer = setTimeout(() => void open(), BUSY_RETRY_MS);
            return;
          }
          if (state === "unsupported") {
            setOpenError("Only SuperDoc documents can move to BlockNote.");
            return;
          }
          if (state === "failed") return; // DocWorkspace reopens it in SuperDoc
          if (state === "converted") converting.current = false; // another tab did it
          setPhase(converting.current ? "converting" : "none");
        }
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
          mode === "create" && !converting.current
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
                // Same rows → blocks path as converting, ids kept, so the
                // extraction this triggers leaves the rows (and their author) as is.
                editor.replaceBlocks(editor.document, rowsToBlocks(seed) as Parameters<typeof editor.replaceBlocks>[1]);
              }
              setLiveBlocks(editor.document as unknown as BnBlock[]);
              if (converting.current) void convertNow();
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
  }, [claimRoom, claimToken, convertNow, convex, documentId, editor, fetchToken, prepareBlockNote, ydoc]);

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

  // ---- footer: word count + outline ----
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
      {/* A column, so the sheet (flex-1) reaches the bottom of the view even
          when the text is short, and grows with it when it's long. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div
          className="folio-paper mx-auto my-6 w-full max-w-3xl flex-1 cursor-text sm:my-10"
          style={{ "--folio-prose-font": fontCssValue(meta?.fontFamily) } as React.CSSProperties}
          onMouseDown={focusEndOnBlankPaper}
        >
          <BlockNoteView
            editor={editor}
            editable={phase === "none"} // nothing typed mid-conversion
            theme={resolvedTheme === "dark" ? "dark" : "light"}
            formattingToolbar={false}
          >
            <FolioFormattingToolbar />
          </BlockNoteView>
        </div>
      </div>
      {phase !== "none" && (
        // Covers the editor so nothing is typed mid-check.
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-[var(--folio-backdrop)]/90">
          <p className="text-sm text-muted" aria-live="polite">
            {phase === "failed"
              ? "This document couldn't be moved to the new editor. Reopening it as it was…"
              : phase === "busy"
                ? "Another tab is moving this document to the new editor…"
                : "Moving this document to the new editor…"}
          </p>
        </div>
      )}
      {/* Same quiet pill the other editors use for their save story. */}
      <div
        className={`absolute bottom-5 left-1/2 z-20 flex print:hidden -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-3 py-1 text-xs text-foreground shadow-sm transition-opacity duration-200 ${
          unsynced ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <span aria-live="polite">
          {connection === "failed" ? "Not saved — this document can't sync right now" : "Not saved — reconnecting…"}
        </span>
      </div>
      <SuperDocFooter
        documentId={documentId}
        headings={headings}
        wordCount={wordCount}
        selectedWordCount={selectedWordCount}
        onJump={jumpTo}
        onExport={(format: ExportFormat) => {
          const blocks = editor.document as unknown as BnBlock[];
          return exportBlockNote(toTipTapDoc(blocks), editor.blocksToHTMLLossy(), meta?.title || "Untitled", format);
        }}
      />
    </div>
  );
}
