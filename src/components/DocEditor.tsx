"use client";

import { useEffect, useRef, useState } from "react";
import {
  useEditor,
  EditorContent,
  type Editor as TiptapEditor,
  type JSONContent,
} from "@tiptap/react";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { StarterKit } from "@tiptap/starter-kit";
import { UniqueID } from "@tiptap/extension-unique-id";
import { ListItem } from "@tiptap/extension-list";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Underline } from "@tiptap/extension-underline";
import { Strike } from "@tiptap/extension-strike";
import { ThemeHighlight } from "./extensions/theme-highlight";
import { LineHeight } from "./extensions/line-height";
import { FontSize } from "./extensions/font-size";
import { Indent } from "./extensions/indent";
import { FindReplace as FindReplaceExtension } from "./extensions/find-replace";
import { PlainPaste } from "./extensions/plain-paste";
import { FootnoteReference, Footnote, FootnoteSync } from "./extensions/footnote";
import { fontCssValue } from "@/lib/fonts";
import { registerPendingSaveFlush } from "@/lib/pendingSave";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  Attribution,
  attributionPluginKey,
  type AttrInfo,
} from "./extensions/attribution";
import { SmartTypography } from "./extensions/typography";
import { Toolbar } from "./Toolbar";
import { Outline } from "./Outline";
import { FindReplace } from "./FindReplace";

// Top-level block node types that get a stable UniqueID (and thus a Convex row).
const BLOCK_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "bulletList",
  "orderedList",
  "horizontalRule",
  "footnote",
];

const DEBOUNCE_MS = 600;
const WORD_COUNT_KEY = "folio:wordCount:visible";
/** Backoff for a failed save. The last step repeats for as long as the tab is
 *  open — a save that could still land should never be quietly abandoned in a
 *  longform editor. */
const RETRY_BACKOFF_MS = [2000, 5000, 15000, 30000];
/** An autosave only announces itself if the round-trip outlasts this. Folio's
 *  page is meant to be quiet, and a pill that strobed "Saving…/Saved" on every
 *  600ms typing pause would be the opposite of that. Failures never wait. */
const SAVING_GRACE_MS = 350;
const SAVED_FLASH_MS = 1600;

type SaveStatus = "idle" | "saving" | "saved" | "retrying" | "error";

/**
 * Errors `reconcile` throws that retrying can never fix: the document is gone,
 * or this account no longer has access to it. Everything else — a dropped
 * connection, a write conflict, a Clerk token mid-refresh — is worth retrying,
 * so the default is "retryable."
 */
function isTerminalSaveError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return message.includes("Not found");
}

const countWords = (text: string): number => {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
};

/** Words inside the live selection, for the `930/1996 words` readout. Only the
 *  selection is measured here — the document total is recomputed on edit, not
 *  on every cursor move. */
const countSelection = (editor: TiptapEditor): number => {
  const { from, to, empty } = editor.state.selection;
  if (empty) return 0;
  // Explicit block + leaf separators: without them a selection spanning two
  // blocks fuses the last word of one onto the first of the next and undercounts.
  return countWords(editor.state.doc.textBetween(from, to, " ", " "));
};

type DesiredBlock = { blockId: string; type: string; content: JSONContent };

/**
 * Snapshot the editor's top-level nodes into the reconcile payload.
 * Returns null if a duplicate id is present — that means UniqueID hasn't yet
 * reassigned a fresh id after a split/paste, so we skip this flush rather than
 * collide two rows on the same blockId (the spec's "most likely 1am bug").
 * Nodes still missing an id are dropped; the next flush picks them up.
 */
function buildDesired(editor: TiptapEditor): DesiredBlock[] | null {
  const top = (editor.getJSON().content ?? []) as JSONContent[];
  const desired: DesiredBlock[] = [];
  const seen = new Set<string>();
  for (const node of top) {
    const id = node.attrs?.id;
    if (typeof id !== "string") continue;
    if (seen.has(id)) return null;
    seen.add(id);
    desired.push({ blockId: id, type: node.type ?? "paragraph", content: node });
  }
  return desired;
}

/** Order-independent deep equality — mirrors convex/blocks.ts's deepEqual.
 *  ProseMirror node JSON round-tripped through Convex can come back with
 *  reordered object keys, so plain JSON.stringify comparison isn't safe:
 *  it would read identical content as "changed," permanently pin a block as
 *  locally dirty, and silently stop accepting a collaborator's edits to it. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * Merge a collaborator's changes into the live editor without clobbering
 * whatever the local person is mid-typing. Without this, `reconcile`'s
 * full-snapshot model meant two people with the same document open would
 * silently tombstone each other's work — whoever's debounced flush landed
 * last "won."
 *
 * Per block, compared against `synced` (the content this client last knew
 * client and server to agree on):
 *   - new on the server, missing locally, never synced here → adopt it
 *   - missing locally but WAS synced here → we deleted it and the flush just
 *     hasn't landed; don't resurrect it, let the flush tombstone it
 *   - local already matches the server              → nothing to do (this is
 *     also how our own edit lands once it round-trips back through the
 *     reactive query)
 *   - local still matches `synced` but the server moved on → safe to take
 *     the server's version (no local edit in flight here)
 *   - local has diverged from `synced` *and* differs from the server → a
 *     real conflict on this exact block; local wins for now and will
 *     overwrite the server on its own next flush
 *   - present locally but missing from the server (deleted elsewhere)  →
 *     drop it, unless local has an unsynced edit on it, in which case keep
 *     it (the next flush revives it — `reconcile` already supports that for
 *     undo, so a delete/edit race resolves the same way).
 *
 * Bails out entirely if any top-level node is still missing its UniqueID —
 * the same window `buildDesired` guards against (right after Enter/split/
 * paste) — rather than reading a not-yet-tagged node as absent and deleting it.
 */
function mergeRemoteChanges(
  editor: TiptapEditor,
  serverBlocks: { blockId: string; content: JSONContent }[],
  synced: Map<string, JSONContent>,
): void {
  const { state } = editor;
  const { schema } = state;

  const localOrder: string[] = [];
  const localById = new Map<string, PMNode>();
  const localOffsetById = new Map<string, number>();
  let hasUntaggedNode = false;
  state.doc.forEach((node, offset) => {
    const id = node.attrs?.id as string | undefined;
    if (!id) {
      hasUntaggedNode = true;
      return;
    }
    localOrder.push(id);
    localById.set(id, node);
    localOffsetById.set(id, offset);
  });
  if (hasUntaggedNode) return; // ids still settling — retry on the next tick

  // Capture the cursor's block + offset-within-block now, before the doc
  // changes underneath it — replaceWith spans the whole document as one
  // step, so ProseMirror's own position mapping doesn't track this per node.
  const sel = state.selection;
  let selBlockId: string | null = null;
  let selOffset = 0;
  for (const id of localOrder) {
    const node = localById.get(id)!;
    const offset = localOffsetById.get(id)!;
    // Strictly interior — sel.head === offset + node.nodeSize is the
    // position just *after* this node, which is also the next node's
    // offset. Matching it here would attribute a cursor at the start of
    // block N+1 to the end of block N instead.
    if (sel.head > offset && sel.head < offset + node.nodeSize) {
      selBlockId = id;
      selOffset = sel.head - (offset + 1);
      break;
    }
  }

  const targetIds = serverBlocks.map((b) => b.blockId);
  const targetIdSet = new Set(targetIds);
  const serverById = new Map(serverBlocks.map((b) => [b.blockId, b.content]));

  const finalById = new Map<string, PMNode>();
  for (const id of targetIds) {
    const serverContent = serverById.get(id)!;
    const localNode = localById.get(id);
    if (!localNode) {
      if (synced.has(id)) continue; // locally deleted, flush pending — don't resurrect
      finalById.set(id, schema.nodeFromJSON(serverContent));
      synced.set(id, serverContent);
      continue;
    }
    const localJSON = localNode.toJSON();
    if (deepEqual(localJSON, serverContent)) {
      finalById.set(id, localNode);
      synced.set(id, serverContent);
      continue;
    }
    const baseline = synced.get(id);
    if (baseline !== undefined && deepEqual(localJSON, baseline)) {
      finalById.set(id, schema.nodeFromJSON(serverContent));
      synced.set(id, serverContent);
    } else {
      finalById.set(id, localNode); // unsynced local edit — don't overwrite it
    }
  }

  // Local-only ids: either a brand-new block we haven't flushed yet, or one
  // a collaborator just deleted while we had an unsynced edit on it. Both
  // get the same treatment — keep it, spliced back in near its old neighbor.
  const orphanIds: string[] = [];
  for (const id of localOrder) {
    if (targetIdSet.has(id)) continue;
    const baseline = synced.get(id);
    const localJSON = localById.get(id)!.toJSON();
    if (baseline !== undefined && deepEqual(localJSON, baseline)) {
      synced.delete(id); // confirmed clean delete — drop the bookkeeping too
      continue;
    }
    orphanIds.push(id);
    finalById.set(id, localById.get(id)!);
  }

  // finalOrder tracks only ids we actually decided to keep — targetIds minus
  // any skipped as "locally deleted, flush pending" above.
  const finalOrder = targetIds.filter((id) => finalById.has(id));
  for (const id of orphanIds) {
    const localIdx = localOrder.indexOf(id);
    let anchor = -1;
    for (let i = localIdx - 1; i >= 0; i--) {
      const idx = finalOrder.indexOf(localOrder[i]);
      if (idx !== -1) {
        anchor = idx;
        break;
      }
    }
    finalOrder.splice(anchor + 1, 0, id);
  }

  if (finalOrder.length === 0) return; // never force the doc empty via merge

  const changed =
    finalOrder.length !== localOrder.length ||
    finalOrder.some((id, i) => id !== localOrder[i] || finalById.get(id) !== localById.get(id));
  if (!changed) return;

  const fragment = Fragment.fromArray(finalOrder.map((id) => finalById.get(id)!));
  const tr = state.tr.replaceWith(0, state.doc.content.size, fragment);
  tr.setMeta("addToHistory", false); // a collaborator's edit isn't local undo history
  // Without this, Tiptap's onUpdate fires for this transaction just like a
  // real keystroke would — resetting the user's pending save debounce and
  // queuing a redundant re-flush of the content we just adopted FROM the
  // server, right back TO it.
  tr.setMeta("preventUpdate", true);

  // Restore the cursor into the same block by explicit position, not
  // ProseMirror's mapping (which collapses across a whole-doc replace).
  if (selBlockId && finalById.has(selBlockId)) {
    let newOffset = 0;
    for (const id of finalOrder) {
      const node = finalById.get(id)!;
      if (id === selBlockId) {
        const clamped = Math.max(0, Math.min(selOffset, node.content.size));
        const pos = Math.max(0, Math.min(newOffset + 1 + clamped, tr.doc.content.size));
        // .near, not .create — a block type without text content (e.g.
        // horizontalRule) at exactly this position would make .create throw
        // mid-effect; .near snaps to the closest valid text selection instead.
        tr.setSelection(TextSelection.near(tr.doc.resolve(pos)));
        break;
      }
      newOffset += node.nodeSize;
    }
  }

  editor.view.dispatch(tr);
}

export function DocEditor({ documentId }: { documentId: Id<"documents"> }) {
  const blocks = useQuery(api.blocks.list, { documentId });
  const doc = useQuery(api.documents.get, { documentId });
  const reconcile = useMutation(api.blocks.reconcile);
  const setFontFamily = useMutation(api.documents.setFontFamily);
  const setWordGoal = useMutation(api.documents.setWordGoal);
  const title = doc?.title?.trim() || "Untitled";

  const loadedRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Hash of the last desired-state we successfully synced; lets us skip
  // reconcile calls that wouldn't change anything.
  const lastSyncedHashRef = useRef<string | null>(null);
  // Per-block "last content client and server agreed on" — mergeRemoteChanges'
  // baseline for deciding whether a block is safe to overwrite with a
  // collaborator's version or has an unsynced local edit in flight.
  const syncedContentRef = useRef<Map<string, JSONContent>>(new Map());
  // Transient "Saved" confirmation.
  const savedHideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Deferred "Saving…" for an autosave — see SAVING_GRACE_MS.
  const savingShowRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = useRef(0);
  // Monotonic save counter: a slow response that resolves after a newer save
  // started must not write the pill back to its own outcome.
  const saveSeqRef = useRef(0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  // Mirror of saveStatus readable synchronously inside the save path, which
  // needs the current state to decide (e.g. whether the writer ever saw
  // "Saving…") without the double-invoke hazards of a functional updater.
  const saveStatusRef = useRef<SaveStatus>("idle");
  const [wordCount, setWordCount] = useState(0);
  const [selectedWordCount, setSelectedWordCount] = useState(0);
  // Persisted so the toggle stays put across visits, like the dock's own
  // sizing preferences. Read lazily so there's no SSR markup to mismatch —
  // this component only mounts client-side.
  const [wordCountVisible, setWordCountVisible] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(WORD_COUNT_KEY) === "true";
  });
  const toggleWordCount = () => {
    setWordCountVisible((prev) => {
      const next = !prev;
      window.localStorage.setItem(WORD_COUNT_KEY, String(next));
      return next;
    });
  };

  // Reuses the native-prompt pattern Toolbar's link button already uses
  // rather than a new dialog — a blank/cleared input clears the goal.
  const editWordGoal = () => {
    const input = window.prompt(
      "Word count goal (blank to clear)",
      doc?.wordGoal ? String(doc.wordGoal) : "",
    );
    if (input === null) return; // cancelled
    const trimmed = input.trim();
    if (trimmed === "") {
      void setWordGoal({ documentId, wordGoal: null });
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) return; // ignore invalid input
    void setWordGoal({ documentId, wordGoal: Math.round(n) });
  };

  const clearTimer = (ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (ref.current) {
      clearTimeout(ref.current);
      ref.current = null;
    }
  };

  const applyStatus = (next: SaveStatus) => {
    saveStatusRef.current = next;
    setSaveStatus(next);
  };

  const cancelRetry = () => {
    clearTimer(retryRef);
    retryAttemptRef.current = 0;
  };

  const flashSaved = () => {
    applyStatus("saved");
    clearTimer(savedHideRef);
    savedHideRef.current = setTimeout(() => {
      savedHideRef.current = null;
      if (saveStatusRef.current === "saved") applyStatus("idle");
    }, SAVED_FLASH_MS);
  };

  const scheduleRetry = (editor: TiptapEditor) => {
    const attempt = retryAttemptRef.current;
    const delay = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
    retryAttemptRef.current = attempt + 1;
    clearTimer(retryRef);
    retryRef.current = setTimeout(() => {
      retryRef.current = null;
      void pushSave(editor, { explicit: false });
    }, delay);
  };

  /**
   * The one write path: the debounced autosave, onBlur, unmount, Ctrl/Cmd+S and
   * every retry all land here, so the save pill and the retry loop see the real
   * state of persistence rather than only the explicit saves.
   *
   * Re-snapshots the editor on every call, retries included — replaying a
   * payload captured before a collaborator's merge landed would clobber it.
   *
   * Resolves true only when the editor's content is confirmed on the server;
   * the update toast awaits that before reloading the tab (lib/pendingSave.ts).
   */
  const pushSave = async (
    editor: TiptapEditor,
    { explicit }: { explicit: boolean },
  ): Promise<boolean> => {
    const desired = buildDesired(editor);
    if (desired === null) {
      // Duplicate ids — UniqueID hasn't reassigned after a split/paste yet.
      // A deliberate skip, not a failure, so the pill is left alone; the next
      // edit re-attempts. There IS unflushed work though, so no caller may
      // read this as "safe to reload."
      return false;
    }
    const hash = JSON.stringify(desired);
    if (hash === lastSyncedHashRef.current) {
      // Already on the server — including the case where a retry raced a
      // successful save, so any queued retry and any stale failure are moot.
      cancelRetry();
      if (
        explicit ||
        saveStatusRef.current === "retrying" ||
        saveStatusRef.current === "error"
      ) {
        flashSaved();
      }
      return true;
    }

    const seq = ++saveSeqRef.current;
    clearTimer(savingShowRef);
    // An armed retry for the same work is redundant now that a fresh attempt is
    // starting, and letting both run would put two reconciles in flight. Keep
    // the attempt count, so the backoff doesn't restart on every keystroke.
    clearTimer(retryRef);
    if (explicit) {
      applyStatus("saving");
    } else if (saveStatusRef.current === "idle" || saveStatusRef.current === "saved") {
      savingShowRef.current = setTimeout(() => {
        savingShowRef.current = null;
        if (saveSeqRef.current === seq) applyStatus("saving");
      }, SAVING_GRACE_MS);
    }

    try {
      await reconcile({ documentId, blocks: desired });
      lastSyncedHashRef.current = hash;
      clearTimer(savingShowRef);
      cancelRetry();
      if (seq !== saveSeqRef.current) return true; // a newer save owns the pill
      // Confirm out loud only if the writer asked, already saw "Saving…", or is
      // looking at a failure that just cleared. A silent autosave stays silent.
      if (
        explicit ||
        saveStatusRef.current === "saving" ||
        saveStatusRef.current === "retrying" ||
        saveStatusRef.current === "error"
      ) {
        flashSaved();
      }
      return true;
    } catch (e) {
      clearTimer(savingShowRef);
      console.error("Folio: block reconcile failed", e);
      if (seq !== saveSeqRef.current) return false; // a newer save owns the pill
      if (isTerminalSaveError(e)) {
        // Retrying can't fix this one, and an unbounded loop against a
        // permanent rejection is worse than a visible dead end.
        cancelRetry();
        applyStatus("error");
      } else {
        applyStatus("retrying");
        scheduleRetry(editor);
      }
      return false;
    }
  };

  const flush = (editor: TiptapEditor) => {
    void pushSave(editor, { explicit: false });
  };

  /** Explicit save (Ctrl/Cmd+S, and the pill's "Try again"). */
  const saveNow = (editor: TiptapEditor): Promise<boolean> => {
    clearTimer(debounceRef);
    return pushSave(editor, { explicit: true });
  };

  const editor = useEditor({
    immediatelyRender: false, // required for Next.js SSR (TipTap v3)
    extensions: [
      StarterKit.configure({
        // Link ships with StarterKit v3; don't follow links while editing.
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: "https",
        },
        // Underline/Strike are pulled out below with their own priority —
        // see the comment there for why.
        underline: false,
        strike: false,
        // ListItem is pulled out below to widen its content expression.
        listItem: false,
      }),
      // A bullet/numbered line can become a heading. ListItem ships with
      // `content: "paragraph block*"`, so the first child HAD to be a
      // paragraph and setHeading inside a list silently no-op'd — the only
      // way to get a big list line was to resize it by hand. extendNodeSchema
      // can't fix this (the node's own `content` field overrides whatever it
      // returns), so the node itself gets extended. Paragraph stays first in
      // the choice so it's still the default type for a new/empty item.
      ListItem.extend({ content: "(paragraph|heading) block*" }),
      UniqueID.configure({ types: BLOCK_TYPES }),
      Attribution,
      SmartTypography,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      ThemeHighlight.configure({ multicolor: true }),
      // TextStyle ships with priority 101 (vs. everything else's default 100),
      // which put its color span OUTSIDE bold/italic/etc. in the rendered DOM —
      // so `.prose strong`'s own color rule won the text's computed color
      // instead of the span's inline one. Lowering it puts color innermost,
      // closest to the text, so it always wins.
      TextStyle.extend({ priority: 50 }),
      Color,
      // Underline/Strike need the OPPOSITE nesting from strong/em/code/a:
      // `.prose u`/`.prose s` have no explicit color rule to fight, and a
      // decoration line's color is fixed to whatever the establishing
      // element's own `color` is — a descendant span can't override it.
      // So these must stay OUTSIDE the TextStyle color span (priority below
      // TextStyle's 50), the opposite of strong/em/code/a above.
      Underline.extend({ priority: 10 }),
      Strike.extend({ priority: 10 }),
      LineHeight,
      FontSize,
      Indent,
      FindReplaceExtension,
      PlainPaste,
      FootnoteReference,
      Footnote,
      FootnoteSync,
    ],
    editorProps: {
      attributes: {
        // prose-lg = longform reading size; the default 65ch measure (no
        // max-w-none) + mx-auto centers the column as a page in calm space.
        // The attribution tick lives in the left margin now, so no pl gutter.
        class: "prose prose-lg mx-auto min-h-[60vh] focus:outline-none",
      },
      // Ctrl/Cmd+click opens a link in a new tab; a plain click just places the
      // cursor to edit it (Link is configured with openOnClick: false).
      handleClick(_view, _pos, event) {
        if (!(event.metaKey || event.ctrlKey)) return false;
        const href = (event.target as HTMLElement | null)
          ?.closest("a")
          ?.getAttribute("href");
        if (!href) return false;
        window.open(href, "_blank", "noopener,noreferrer");
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      setWordCount(countWords(editor.getText()));
      setSelectedWordCount(countSelection(editor));
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => flush(editor), DEBOUNCE_MS);
    },
    onSelectionUpdate: ({ editor }) => {
      setSelectedWordCount(countSelection(editor));
    },
    onBlur: ({ editor }) => {
      // Save promptly when leaving the editor — flush the pending debounce now.
      if (debounceRef.current) clearTimeout(debounceRef.current);
      flush(editor);
    },
  });

  // Load DB content once. setContent is silent (emitUpdate:false) and we then
  // record the synced hash, so the load never triggers a redundant reconcile.
  useEffect(() => {
    if (!editor || loadedRef.current || blocks === undefined) return;
    loadedRef.current = true;
    if (blocks.length > 0) {
      editor.commands.setContent(
        { type: "doc", content: blocks.map((b) => b.content as JSONContent) },
        { emitUpdate: false },
      );
    }
    for (const b of blocks) {
      syncedContentRef.current.set(b.blockId, b.content as JSONContent);
    }
    const desired = buildDesired(editor);
    lastSyncedHashRef.current = desired ? JSON.stringify(desired) : null;
    setWordCount(countWords(editor.getText()));
  }, [editor, blocks]);

  // Every subsequent update (ours echoing back, or a collaborator's) merges
  // in rather than reloading — see mergeRemoteChanges for why a full reload
  // here would silently clobber whoever's debounced flush lands second.
  useEffect(() => {
    if (!editor || !loadedRef.current || blocks === undefined) return;
    mergeRemoteChanges(
      editor,
      blocks.map((b) => ({ blockId: b.blockId, content: b.content as JSONContent })),
      syncedContentRef.current,
    );
  }, [editor, blocks]);

  // Push live attribution (author + lastEditedAt per block) into the editor so
  // the gutter decorations reflect persisted state. Meta-only transaction —
  // no doc change, so it never triggers a reconcile.
  useEffect(() => {
    if (!editor || blocks === undefined) return;
    const map = new Map<string, AttrInfo>();
    for (const b of blocks) {
      map.set(b.blockId, {
        author: b.author,
        authorName: b.authorName,
        lastEditedAt: b.lastEditedAt,
      });
    }
    editor.view.dispatch(editor.state.tr.setMeta(attributionPluginKey, map));
  }, [editor, blocks]);

  // Flush any pending debounce on unmount so the last edit isn't lost.
  useEffect(() => {
    const editorRef = editor;
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        if (editorRef) flush(editorRef);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Ctrl/Cmd+S → save now (and swallow the browser's save-page dialog).
  useEffect(() => {
    if (!editor) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "s" || e.key === "S")
      ) {
        e.preventDefault();
        void saveNow(editor);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Let the update toast flush this editor before it reloads the tab — Folio
  // holds longform drafts, so reloading over an in-flight block save is the
  // one thing that must never happen. saveNow closes over stable refs and
  // mutations, so re-registering only when the editor itself changes is right.
  useEffect(() => {
    if (!editor) return;
    return registerPendingSaveFlush(() => saveNow(editor));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Warn before leaving only when the editor's content genuinely hasn't reached
  // the server — a pending debounce, a save in flight, or one that failed. A
  // prompt on every close would train the writer to dismiss it on reflex.
  useEffect(() => {
    if (!editor) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const desired = buildDesired(editor);
      // null means ids are still settling, which is also unflushed work.
      const dirty =
        desired === null || JSON.stringify(desired) !== lastSyncedHashRef.current;
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = ""; // some browsers still require this to show the prompt
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [editor]);

  // Don't make a failed save wait out its backoff once the tab can plainly
  // reach the network again. `online` also resets the backoff; coming back to
  // the tab keeps it, so repeated tab-switching can't tighten the loop.
  useEffect(() => {
    if (!editor) return;
    const retryNow = (resetBackoff: boolean) => {
      if (saveStatusRef.current !== "retrying") return;
      if (document.visibilityState === "hidden") return;
      clearTimer(retryRef);
      if (resetBackoff) retryAttemptRef.current = 0;
      void pushSave(editor, { explicit: false });
    };
    const onOnline = () => retryNow(true);
    const onVisible = () => retryNow(false);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Drop every save timer on unmount. Defined last so it runs after the flush
  // effect's cleanup above, which may schedule one.
  useEffect(
    () => () => {
      if (savedHideRef.current) clearTimeout(savedHideRef.current);
      if (savingShowRef.current) clearTimeout(savingShowRef.current);
      if (retryRef.current) clearTimeout(retryRef.current);
    },
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {editor ? (
        <Toolbar
          editor={editor}
          title={title}
          fontFamily={doc?.fontFamily}
          onFontFamilyChange={(key) => void setFontFamily({ documentId, fontFamily: key })}
        />
      ) : (
        <div className="h-11 shrink-0 border-b border-foreground/10 bg-[var(--folio-backdrop)]" />
      )}
      {/* The containing block for the find bar: the editor column, below the
          toolbar. The bar used to be `fixed`, i.e. positioned against the
          viewport, which painted it over the toolbar's right-hand controls and
          over the changes/Cleo dock — a real in-flow element at lg and up, and
          user-resizable. Anchored here it clears the toolbar and follows the
          column's width as the dock is dragged, for free. It sits outside the
          scroll area so it doesn't scroll away with the prose. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {editor && <FindReplace editor={editor} />}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
            <div
              className="folio-paper"
              style={{ "--folio-prose-font": fontCssValue(doc?.fontFamily) } as React.CSSProperties}
            >
              {editor ? (
                <EditorContent editor={editor} />
              ) : (
                <div className="min-h-[60vh]" />
              )}
            </div>
          </div>
        </div>
      </div>
      {/* One pill for the whole save story. A failure reads as a status line,
          not an alarm: same paper chrome, just full-strength text and an
          affordance, because the north star is a page that stays calm. */}
      <div
        className={`fixed bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-3 py-1 text-xs shadow-sm transition-opacity duration-200 ${
          saveStatus === "idle" ? "pointer-events-none opacity-0" : "opacity-100"
        } ${
          saveStatus === "retrying" || saveStatus === "error"
            ? "text-foreground"
            : "pointer-events-none text-foreground/60"
        }`}
      >
        <span aria-live="polite">
          {saveStatus === "saving"
            ? "Saving…"
            : saveStatus === "retrying"
              ? "Not saved — retrying…"
              : saveStatus === "error"
                ? "Not saved"
                : "Saved"}
        </span>
        {(saveStatus === "retrying" || saveStatus === "error") && editor && (
          <button
            onClick={() => {
              retryAttemptRef.current = 0;
              void saveNow(editor);
            }}
            className="underline decoration-foreground/30 underline-offset-2 transition hover:decoration-foreground"
          >
            Try again
          </button>
        )}
      </div>
      <div className="fixed bottom-5 left-5 z-20 flex items-center gap-2">
        {editor && <Outline editor={editor} />}
        <button
          onClick={toggleWordCount}
          aria-pressed={wordCountVisible}
          title={
            !wordCountVisible
              ? "Show word count"
              : selectedWordCount > 0
                ? "Words in selection / in document — click to hide"
                : "Hide word count"
          }
          className="rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-3 py-1 text-xs text-foreground/60 shadow-sm transition hover:text-foreground"
        >
          {!wordCountVisible
            ? "Word count"
            : selectedWordCount > 0
              ? // A live selection takes the badge over the goal — while you're
                // measuring a passage, that's the number you're after.
                `${selectedWordCount.toLocaleString()}/${wordCount.toLocaleString()} words`
              : doc?.wordGoal
                ? `${wordCount.toLocaleString()} / ${doc.wordGoal.toLocaleString()} words`
                : `${wordCount.toLocaleString()} words`}
        </button>
        {wordCountVisible && (
          <button
            onClick={editWordGoal}
            title={doc?.wordGoal ? "Edit word goal" : "Set a word goal"}
            className="rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-2 py-1 text-xs text-foreground/40 shadow-sm transition hover:text-foreground"
          >
            {doc?.wordGoal ? "Edit goal" : "Set goal"}
          </button>
        )}
      </div>
    </div>
  );
}
