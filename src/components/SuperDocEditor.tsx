"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@clerk/nextjs";
import { useConvex, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import {
  SuperDocEditor as SuperDoc,
  type SuperDocReadyEvent,
} from "@superdoc-dev/react";
import "@superdoc-dev/react/style.css";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { registerPendingSaveFlush } from "@/lib/pendingSave";
import { toReconcileBlocks, type SdBlock, type SdProjection } from "@/superdoc/extract";
import {
  defaultSuperDocFont,
  fontForLegacyKey,
  SUPERDOC_FONT_OPTIONS,
  superDocFontsConfig,
  templateUrl,
} from "@/superdoc/fonts";
import { convertInto } from "@/superdoc/runConversion";
import { createFolioExtension, type BlockAttribution } from "@/superdoc/folioExtension";
import {
  exportSuperDoc,
  SUPERDOC_EXPORT_FORMATS,
  type SuperDocExportFormat,
} from "@/superdoc/exportDocument";
import { relativeTime } from "@/lib/time";
import { replayTyping } from "@/superdoc/typography";
import { countWords, SuperDocFooter, type OutlineHeading } from "./SuperDocFooter";

/** Built by scripts/build-superdoc-assets.mjs (as are the templates). */
const COLLAB_WORKER_URL = "/superdoc/collab-worker.js";
/** Quiet time after an edit before the derived block rows are rebuilt. */
const EXTRACT_DEBOUNCE_MS = 1000;
/** How long to wait before re-claiming a room another tab is still creating. */
const CLAIM_RETRY_MS = 2000;
/** How often to check back while another tab converts this document. */
const BUSY_RETRY_MS = 5000;
/** How long a converted document's first save may take before giving up. */
const SAVE_TIMEOUT_MS = 30_000;

/** Converting a TipTap document on open (migration phase 4). */
type ConversionPhase = "none" | "preparing" | "busy" | "converting" | "stuck";

/** The TipTap document this editor is converting. */
export type LegacySource = { fontKey?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RoomMode = "create" | "join";
type Connection = "connecting" | "synced" | "degraded" | "failed";
/** "paginated" = paper pages (SuperDoc's default); "web" = one continuous page. */
type Layout = "paginated" | "web";

/** Per-device choice — a viewing preference, not part of the document. */
const LAYOUT_KEY = "folio:superdoc-layout";

/** A phone (either orientation) or small tablet: touch, and too narrow for a
 *  letter-size page at full size. A narrow desktop window doesn't count — it
 *  keeps full editing in both layouts. */
const MOBILE_QUERY = "(pointer: coarse) and (max-width: 1023px)";
const isMobileNow = (): boolean => {
  try {
    return window.matchMedia(MOBILE_QUERY).matches;
  } catch {
    return false;
  }
};
const subscribeMobile = (onChange: () => void) => {
  const mq = window.matchMedia(MOBILE_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
};

/** Paginated pages scale down to fit a narrow column (never up past 100%). */
const FIT_WIDTH_ZOOM = { mode: "fit-width" as const, fitWidth: { padding: 16 } };

const readLayout = (): Layout => {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "web" ? "web" : "paginated";
  } catch {
    return "paginated"; // storage blocked (private window etc.)
  }
};

/** Built-in toolbar controls Folio doesn't use: no AI provider is configured,
 *  and Folio has no suggesting/tracked-changes or ruler-unit workflow. */
const EXCLUDED_TOOLBAR_ITEMS = [
  "ai",
  "document-mode",
  "track-changes-accept-selection",
  "track-changes-reject-selection",
  "measurement-unit",
] as const;

const fontsConfig = superDocFontsConfig();

/** The slice of SuperDoc's browser Document API this editor reads. */
type MaybePromise<T> = T | Promise<T>;
type TextPoint = { kind: "text"; blockId: string; offset: number };
type SelectionInfo = {
  empty?: boolean;
  text?: string;
  /** Start/end form (`target` is the segments form, not used here). */
  selectionTarget?: {
    kind: "selection";
    start: TextPoint | { kind: string };
    end: TextPoint | { kind: string };
  } | null;
};

/** The caret, when the selection is a plain collapsed point inside text. */
const caretOf = (sel: SelectionInfo): TextPoint | null => {
  const start = sel.selectionTarget?.start;
  const end = sel.selectionTarget?.end;
  if (!sel.empty || !start || !end || start.kind !== "text" || end.kind !== "text") return null;
  const a = start as TextPoint;
  const b = end as TextPoint;
  return a.blockId === b.blockId && a.offset === b.offset ? a : null;
};
type DocApi = {
  blocks: { list(input: unknown): MaybePromise<{ blocks: SdBlock[] }> };
  projectMarkdown?(input: unknown): Promise<SdProjection>;
  selection: { current(input?: { includeText?: boolean }): MaybePromise<SelectionInfo> };
  replace(input: unknown): unknown;
  getMarkdown(input: object): MaybePromise<string>;
  getHtml(input: object): MaybePromise<string>;
  getText(input: object): MaybePromise<string>;
};
/** The slice of the SuperDoc instance this editor drives. */
type SuperDocInstance = {
  navigateTo(target: unknown): Promise<boolean>;
  export(params: object): Promise<unknown>;
};

/** Live handles shared by callbacks SuperDoc holds on to (toolbar items,
 *  extension hooks). Those callbacks are built during render, so the handles
 *  live behind methods on a stable object rather than in refs. */
function createSession() {
  let superdoc: SuperDocInstance | null = null;
  let doc: DocApi | null = null;
  let title = "";
  return {
    attach(next: { superdoc: SuperDocInstance; doc: DocApi | null }) {
      superdoc = next.superdoc;
      doc = next.doc;
    },
    setTitle(next: string) {
      title = next;
    },
    get: () => ({ superdoc, doc, title }),
  };
}

/**
 * A document edited in SuperDoc. Its Y.Doc lives in Convex (convex/ydoc.ts),
 * synced by the "convex" provider adapter inside SuperDoc's collaboration
 * worker (src/superdoc/). This component owns what the worker can't:
 *   - claiming the room (create vs join) before SuperDoc mounts,
 *   - rebuilding the derived `blocks` rows after edits settle, so the diff
 *     panel, attribution, Cleo and the MCP door keep working,
 *   - telling the writer when edits aren't reaching the server.
 */
export function SuperDocEditor({
  documentId,
  legacy,
}: {
  documentId: Id<"documents">;
  /** Set while the document is still on TipTap: it's converted on open,
   *  and this editor stays open as its editor afterwards. */
  legacy?: LegacySource;
}) {
  const { getToken } = useAuth();
  // SuperDoc rebuilds the editor when `document` changes, so the token
  // resolver it holds must be stable. Clerk's getToken is (a useCallback on
  // the Clerk instance) and always returns a current token.
  const fetchToken = useCallback(
    async () => (await getToken({ template: "convex" })) ?? "",
    [getToken],
  );

  const convex = useConvex();
  const claimRoom = useMutation(api.ydoc.claimRoom);
  const reconcile = useMutation(api.blocks.reconcile);
  const prepareConversion = useMutation(api.conversion.prepare);
  const finishConversion = useMutation(api.conversion.finish);
  const failConversion = useMutation(api.conversion.fail);

  // ---- conversion state (phase 4) ----
  // True until this document is on SuperDoc. While it is, the derived block
  // rows still belong to TipTap, so extraction stays off.
  const legacyRef = useRef(legacy !== undefined);
  const [phase, setPhase] = useState<ConversionPhase>(legacy ? "preparing" : "none");
  // The DOCX a new room starts from, in the document's font. Fixed at mount.
  const [template] = useState(() =>
    templateUrl(legacy ? fontForLegacyKey(legacy.fontKey) : defaultSuperDocFont()),
  );
  useEffect(() => {
    // Converted (here or in another tab): an ordinary SuperDoc document now.
    if (!legacy) legacyRef.current = false;
  }, [legacy]);
  // Waiting on a conversion that has since landed elsewhere → nothing to show.
  const shownPhase: ConversionPhase =
    !legacy && (phase === "preparing" || phase === "busy") ? "none" : phase;

  // ---- room claim (decided once, before SuperDoc mounts) ----
  const [roomMode, setRoomMode] = useState<RoomMode | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  // Identifies this editor's claim across remounts (StrictMode mounts twice
  // in dev), so re-claiming its own empty room isn't mistaken for another tab.
  const [claimToken] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const claim = async () => {
      try {
        if (legacyRef.current) {
          const state = await prepareConversion({ documentId, claimToken });
          if (cancelled) return;
          if (state === "failed") return; // DocWorkspace reopens it in TipTap
          if (state === "busy") {
            setPhase("busy");
            timer = setTimeout(() => void claim(), BUSY_RETRY_MS);
            return;
          }
        }
        const result = await claimRoom({ documentId, claimToken });
        if (cancelled) return;
        if (result === "wait") timer = setTimeout(() => void claim(), CLAIM_RETRY_MS);
        else setRoomMode(result);
      } catch (e) {
        console.error("Folio: couldn't open the SuperDoc room", e);
        if (!cancelled) setClaimError("This document couldn't be opened.");
      }
    };
    void claim();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // prepareConversion is a stable mutation handle like claimRoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimRoom, documentId, claimToken]);

  const document = useMemo(
    () =>
      roomMode === null
        ? null
        : {
            type: "docx",
            // A room needs a base file. On create it's Folio's template (its
            // styles become the document's: the font, Folio headings); on
            // join the Y.Doc's content replaces it.
            url: template,
            collaboration: {
              providerType: "extension" as const,
              adapterId: "convex",
              documentId,
              roomMode,
              providerOptions: { convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL! },
              token: fetchToken,
            },
          },
    [documentId, roomMode, fetchToken, template],
  );

  // ---- connection state → save pill + unload guard ----
  const [connection, setConnection] = useState<Connection>("connecting");
  const connectionRef = useRef<Connection>("connecting");
  const onConnection = (state: Connection) => {
    // Debug-level (hidden unless the console shows Verbose): the only way to
    // see what the worker reports, since a healthy session shows no UI at all.
    console.debug(`Folio: SuperDoc sync ${connectionRef.current} → ${state}`);
    connectionRef.current = state;
    setConnection(state);
  };
  const unsynced = connection === "degraded" || connection === "failed";

  useEffect(() => {
    if (!unsynced) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // some browsers still require this to show the prompt
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [unsynced]);

  // ---- live handles + Folio's SuperDoc extension ----
  const [session] = useState(createSession);
  const [{ bridge, extension }] = useState(createFolioExtension);
  const extensions = useMemo(() => [extension], [extension]);

  const meta = useQuery(api.documents.get, { documentId });
  useEffect(() => {
    session.setTitle(meta?.title ?? "");
  }, [meta?.title, session]);

  // The latest block listing — feeds word count, the outline and attribution.
  const [liveBlocks, setLiveBlocks] = useState<SdBlock[]>([]);
  const [selectedWordCount, setSelectedWordCount] = useState(0);

  // ---- derived block rows ----
  const extractTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const extracting = useRef<Promise<void> | null>(null);
  const extractAgain = useRef(false);

  const extract = async (): Promise<void> => {
    if (extracting.current) {
      extractAgain.current = true; // an edit landed mid-run; go once more after
      return extracting.current;
    }
    const { doc } = session.get();
    if (!doc || legacyRef.current) return;
    extracting.current = (async () => {
      do {
        extractAgain.current = false;
        try {
          const [{ blocks }, projection] = await Promise.all([
            Promise.resolve(doc.blocks.list({ includeText: true, limit: 20_000 })),
            doc.projectMarkdown
              ? doc.projectMarkdown({}).catch((e: unknown) => {
                  // Formatting is a nice-to-have in the derived copy; text isn't.
                  console.error("Folio: markdown projection failed, saving plain text", e);
                  return null;
                })
              : Promise.resolve(null),
          ]);
          setLiveBlocks(blocks);
          await reconcile({
            documentId,
            blocks: toReconcileBlocks(blocks, projection),
            source: "superdoc",
          });
        } catch (e) {
          // The Y.Doc (the real content) is unaffected; the derived rows catch
          // up on the next edit. Logged, not surfaced — nothing the writer can do.
          const code = e instanceof ConvexError ? (e.data as { code?: string })?.code : undefined;
          console.error(`Folio: block extraction failed${code ? ` (${code})` : ""}`, e);
        }
      } while (extractAgain.current);
    })();
    try {
      await extracting.current;
    } finally {
      extracting.current = null;
    }
  };

  const scheduleExtract = () => {
    clearTimeout(extractTimer.current);
    extractTimer.current = setTimeout(() => void extract(), EXTRACT_DEBOUNCE_MS);
  };

  // The update toast flushes through here before reloading. Edits themselves
  // live in the worker's Y.Doc; while the connection is down, a reload could
  // lose them, so report "not safe". ("connecting" before the first sync
  // holds no local edits yet, so it doesn't block a reload.)
  useEffect(
    () =>
      registerPendingSaveFlush(async () => {
        clearTimeout(extractTimer.current);
        await extract();
        return connectionRef.current !== "degraded" && connectionRef.current !== "failed";
      }),
    // extract reads refs only; registering once per document is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [documentId],
  );

  useEffect(
    () => () => {
      // Leaving the document: rebuild the rows one last time.
      if (extractTimer.current) {
        clearTimeout(extractTimer.current);
        void extract();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ---- layout (paginated ↔ continuous) ----
  // viewOptions is read once at mount, so switching remounts the editor
  // (keyed on layout). The content reloads from Convex — nothing is lost.
  // On mobile, documents always open in Continuous — the layout you can
  // edit in — and Pages is a read-only, fit-to-width preview. The choice
  // isn't saved there: the next document opens ready to edit again.
  const mobile = useSyncExternalStore(subscribeMobile, isMobileNow, () => false);
  const [layout, setLayout] = useState<Layout>(() => (isMobileNow() ? "web" : readLayout()));
  const preview = mobile && layout === "paginated";
  const switchLayout = (next: Layout) => {
    if (next === layout) return;
    if (!mobile) {
      try {
        localStorage.setItem(LAYOUT_KEY, next);
      } catch {
        // not persisted on this device; still switch for this session
      }
    }
    setRoomMode("join"); // the room exists by now — a remount must not "create"
    setLayout(next);
  };

  const runExport = async (value: string | number | undefined) => {
    const format = SUPERDOC_EXPORT_FORMATS.find((f) => f.id === value)?.id;
    const { superdoc, doc, title } = session.get();
    if (!format || !superdoc || !doc) return;
    try {
      await exportSuperDoc(
        {
          doc,
          exportDocx: async () =>
            (await superdoc.export({ exportType: ["docx"], triggerDownload: false })) as Blob,
        },
        title || "Untitled",
        format as SuperDocExportFormat,
      );
    } catch (e) {
      console.error(`Folio: ${format} export failed`, e);
    }
  };

  // ---- attribution: block rows (who/when) × live blocks (where) ----
  const rows = useQuery(api.blocks.list, { documentId });
  const attribution = useMemo<BlockAttribution[]>(() => {
    if (!rows) return [];
    const byId = new Map(rows.map((r) => [r.blockId, r]));
    return liveBlocks.flatMap((b) => {
      const row = byId.get(b.nodeId);
      if (!row) return [];
      return [
        {
          blockId: b.nodeId,
          length: (b.text ?? b.textPreview ?? "").length,
          author: row.author ?? "",
          name: row.author === "claude" ? "Cleo" : (row.authorName ?? "Nae"),
          lastEditedAt: row.lastEditedAt,
        },
      ];
    });
  }, [rows, liveBlocks]);
  useEffect(() => bridge.setAttribution(attribution), [attribution, bridge]);

  // SuperDoc only paints extension decorations in the paginated layout. In
  // the continuous layout, stamp the same class + data onto its blocks (by
  // Word paragraph id) so the one CSS rule draws the tick there too, and
  // re-stamp whenever SuperDoc repaints a block.
  const surfaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const surface = surfaceRef.current;
    if (layout !== "web" || !surface) return;
    const byId = new Map(attribution.map((a) => [a.blockId, a]));
    const stamp = () => {
      surface
        .querySelectorAll<HTMLElement>(".superdoc-web-flow-block[data-source-node-id]")
        .forEach((el) => {
          const a = byId.get(el.dataset.sourceNodeId ?? "");
          el.classList.toggle("folio-attr", Boolean(a));
          if (!a) return;
          el.dataset.superdocExtFolioAuthor = a.author === "claude" ? "claude" : "human";
          el.dataset.superdocExtFolioName = a.name;
          el.dataset.superdocExtFolioEdited = String(a.lastEditedAt);
        });
    };
    stamp();
    // Attribute writes don't trigger a childList observer, so this can't loop.
    const mo = new MutationObserver(stamp);
    mo.observe(surface, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [layout, attribution]);

  // Hover tooltip for the tick ("Nae · edited 2m ago"). Computed on hover so
  // the relative time is never stale.
  const onAttributionHover = (e: React.MouseEvent) => {
    const el = (e.target as Element).closest<HTMLElement>("[data-superdoc-ext-folio-edited]");
    if (!el) return;
    const edited = Number(el.dataset.superdocExtFolioEdited);
    el.title = `${el.dataset.superdocExtFolioName ?? "Someone"} · edited ${relativeTime(edited)}`;
  };

  // Words in the current selection, for the "930/1996 words" readout.
  useEffect(() => {
    bridge.setSelectionHandler(({ collapsed }) => {
      const { doc } = session.get();
      if (collapsed || !doc) {
        setSelectedWordCount(0);
        return;
      }
      void Promise.resolve(doc.selection.current({ includeText: true }))
        .then((sel) => setSelectedWordCount(countWords(sel.text ?? "")))
        .catch(() => setSelectedWordCount(0));
    });
    return () => bridge.setSelectionHandler(null);
  }, [bridge, session]);

  // Every change rebuilds the derived rows (this also catches style-only
  // changes onEditorUpdate misses).
  useEffect(() => {
    bridge.setMutationHandler(() => scheduleExtract());
    return () => bridge.setMutationHandler(null);
    // scheduleExtract only touches refs and stable values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  // Smart typography. SuperDoc has no input-rule hook, its edits land in the
  // worker a beat after the keystroke, and every read is a worker round trip —
  // so instead of checking per keystroke, this tracks the current unbroken
  // RUN of typed characters and, once typing pauses, replays the whole run
  // through the rules (replayTyping) and replaces just what changed.
  //
  // Anything that isn't plain typing ends the run without converting: a click,
  // arrows, Enter, Backspace/Delete, shortcuts (paste, undo…). So a conversion
  // can only ever touch characters just typed, deletions never convert, and an
  // undone conversion stays undone.
  useEffect(() => {
    const PAUSE_MS = 150;
    const MODIFIERS = new Set(["Shift", "Alt", "Meta", "Control", "CapsLock", "Fn"]);
    let run = 0; // typed characters in the current run not yet checked
    let busy = false;
    let unreadable = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const endRun = () => {
      run = 0;
      clearTimeout(timer);
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void check(), PAUSE_MS);
    };

    const check = async (): Promise<void> => {
      const { doc } = session.get();
      if (!doc || run === 0) return;
      if (busy) return schedule();
      busy = true;
      const n = run;
      try {
        const caret = caretOf(await doc.selection.current({}));
        if (!caret) {
          // Briefly unreadable while SuperDoc applies an edit — try again,
          // but not forever (focus may simply have left the editor).
          if (++unreadable > 10) endRun();
          else schedule();
          return;
        }
        unreadable = 0;
        const { blocks } = await doc.blocks.list({ nodeIds: [caret.blockId], includeText: true });
        const before = (blocks[0]?.text ?? "").slice(0, caret.offset);
        if (before.length < n) {
          endRun(); // the run no longer lines up with the text — don't guess
          return;
        }
        const fix = replayTyping(before.slice(0, before.length - n), before.slice(before.length - n));
        if (fix) {
          // Typing resumed while we read? Leave the document alone; the next
          // pause re-checks the whole run.
          const now = caretOf(await doc.selection.current({}));
          if (!now || now.blockId !== caret.blockId || now.offset !== caret.offset) {
            schedule();
            return;
          }
          await doc.replace({
            target: {
              kind: "selection",
              start: { kind: "text", blockId: caret.blockId, offset: fix.from },
              end: { kind: "text", blockId: caret.blockId, offset: caret.offset },
            },
            text: fix.insert,
          });
        }
        // These n characters are settled; anything typed meanwhile stays queued.
        run = Math.max(0, run - n);
        if (run > 0) schedule();
      } catch (e) {
        console.error("Folio: smart typography skipped", e);
        endRun();
      } finally {
        busy = false;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!surfaceRef.current?.contains(e.target as Node)) return;
      if (MODIFIERS.has(e.key)) return;
      // A printable character (Option combos like Option+- included); not a
      // shortcut, not IME composition (which reports "Process").
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.isComposing) {
        run += 1;
        schedule();
        return;
      }
      endRun();
    };
    const onPointerDown = () => endRun();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [session]);

  const wordCount = useMemo(
    () => liveBlocks.reduce((n, b) => n + countWords(b.text ?? b.textPreview ?? ""), 0),
    [liveBlocks],
  );
  const headings = useMemo<OutlineHeading[]>(
    () =>
      liveBlocks
        .filter((b) => b.nodeType === "heading")
        .map((b) => ({ nodeId: b.nodeId, level: b.headingLevel ?? 1, text: (b.text ?? "").trim() })),
    [liveBlocks],
  );
  const jumpTo = (nodeId: string) =>
    void session.get().superdoc?.navigateTo({ kind: "block", nodeId, nodeType: "heading" });

  const ui = useMemo(
    () => ({
      toolbar: {
        // Fit the editor column, not the browser window (SuperDoc's default),
        // so controls that don't fit go into the overflow menu instead of
        // sliding under the changes/Cleo sidebar.
        responsiveTo: "container" as const,
        excludeItems: EXCLUDED_TOOLBAR_ITEMS,
        fontOptions: SUPERDOC_FONT_OPTIONS,
        customItems: [
          // On mobile the layout switch is a footer pill instead (this one
          // would sit in the overflow menu, out of sight).
          ...(mobile ? [] : [{
            id: "folio-layout",
            type: "dropdown" as const,
            region: "right" as const,
            label: layout === "web" ? "Continuous" : "Pages",
            hasCaret: true,
            size: "wide" as const, // room for "Continuous" without truncating
            tooltip: "Page layout",
            selectedValue: layout,
            options: [
              { id: "paginated", label: "Pages" },
              { id: "web", label: "Continuous" },
            ],
            onSelect: ({ value }: { value?: string | number }) =>
              switchLayout(value === "web" ? "web" : "paginated"),
          }]),
          {
            id: "folio-export",
            type: "dropdown" as const,
            region: "right" as const,
            label: "Export",
            hasCaret: true,
            tooltip: "Export document",
            options: SUPERDOC_EXPORT_FORMATS.map((f) => ({ id: f.id, label: f.label })),
            onSelect: ({ value }: { value?: string | number }) => void runExport(value),
          },
        ],
      },
    }),
    // switchLayout closes over layout; rebuilt (with the editor) when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, mobile],
  );

  // ---- converting a TipTap document (phase 4) ----
  const conversionStarted = useRef(false);

  /** Wait until the converted Y.Doc has reached Convex and stopped changing. */
  const waitForSave = async (): Promise<void> => {
    const deadline = Date.now() + SAVE_TIMEOUT_MS;
    let last: number | null = null;
    while (Date.now() < deadline) {
      await sleep(750);
      const head = await convex.query(api.ydoc.head, { documentId });
      if (connectionRef.current === "synced" && head && head.count > 0 && head.latest === last) return;
      last = head?.latest ?? null;
    }
    throw new Error("the converted document didn't finish saving");
  };

  const giveUp = async (reason: string) => {
    console.error(`Folio: couldn't convert this document to SuperDoc — ${reason}`);
    try {
      // Drops the room and records why; DocWorkspace reopens it in TipTap.
      await failConversion({ documentId, reason });
    } catch (e) {
      console.error("Folio: couldn't record the failed conversion", e);
      setPhase("stuck");
    }
  };

  const convert = async (doc: DocApi) => {
    setPhase("converting");
    try {
      // updatedAt first: if a TipTap tab saves after this, finish refuses.
      const meta = await convex.query(api.documents.get, { documentId });
      const rows = await convex.query(api.blocks.list, { documentId });
      if (!meta) throw new Error("the document is unavailable");
      const result = await convertInto(doc, rows);
      if (!result.ok) return await giveUp(result.reason);
      await waitForSave();
      await finishConversion({ documentId, basedOn: meta.updatedAt, blocks: result.blocks });
      legacyRef.current = false;
      setPhase("none");
      void extract();
    } catch (e) {
      const code = e instanceof ConvexError ? (e.data as { code?: string })?.code : undefined;
      await giveUp(code ?? (e instanceof Error ? e.message : String(e)));
    }
  };

  const onReady = ({ superdoc }: SuperDocReadyEvent) => {
    const doc = (superdoc.activeEditor?.doc ?? null) as DocApi | null;
    session.attach({ superdoc: superdoc as unknown as SuperDocInstance, doc });
    if (legacyRef.current && roomMode === "create" && doc && !conversionStarted.current) {
      conversionStarted.current = true;
      void convert(doc);
      return;
    }
    void extract();
  };

  if (claimError) {
    return <p className="px-6 py-10 text-foreground/60">{claimError}</p>;
  }
  if (!document) {
    return (
      <p className="px-6 py-10 text-foreground/50">
        {shownPhase === "busy" ? "Another tab is moving this document to the new editor…" : "Opening…"}
      </p>
    );
  }

  return (
    <div
      ref={surfaceRef}
      className="folio-superdoc relative flex min-h-0 flex-1 flex-col"
      onMouseOver={onAttributionHover}
    >
      <SuperDoc
        key={layout}
        document={document}
        documentMode={preview ? "viewing" : "editing"}
        hideToolbar={preview}
        zoom={layout === "paginated" ? FIT_WIDTH_ZOOM : undefined}
        contained
        ui={ui}
        fonts={fontsConfig}
        extensions={extensions}
        viewOptions={layout === "web" ? { layout: "web" } : undefined}
        telemetry={{ enabled: false }}
        workerUrls={{ collaboration: COLLAB_WORKER_URL }}
        onReady={onReady}
        onEditorUpdate={scheduleExtract}
        onCollaborationConnectionChange={({ state }) => onConnection(state)}
        onException={(e) => {
          // Spell out the error — the raw payload logs as "[object Error]".
          const { error, ...rest } = e as { error?: unknown } & Record<string, unknown>;
          console.error(
            "Folio: SuperDoc exception",
            rest,
            error instanceof Error ? `${error.name}: ${error.message}` : error,
          );
        }}
        className="min-h-0 flex-1"
      />
      {shownPhase !== "none" && (
        // Covers the editor (toolbar too) so nothing is typed mid-check.
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-[var(--folio-backdrop)]/90">
          <p className="text-sm text-foreground/60" aria-live="polite">
            {shownPhase === "stuck"
              ? "This document couldn't be moved to the new editor. Reload to try again."
              : shownPhase === "busy"
                ? "Another tab is moving this document to the new editor…"
                : "Moving this document to the new editor…"}
          </p>
        </div>
      )}
      {/* Same quiet pill the TipTap editor uses for its save story. */}
      <div
        className={`fixed bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-3 py-1 text-xs text-foreground shadow-sm transition-opacity duration-200 ${
          unsynced ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <span aria-live="polite">
          {connection === "failed"
            ? "Not saved — this document can't sync right now"
            : "Not saved — reconnecting…"}
        </span>
      </div>
      <SuperDocFooter
        documentId={documentId}
        headings={headings}
        wordCount={wordCount}
        selectedWordCount={selectedWordCount}
        onJump={jumpTo}
        pagePreview={
          mobile
            ? { active: preview, toggle: () => switchLayout(preview ? "web" : "paginated") }
            : undefined
        }
      />
    </div>
  );
}
