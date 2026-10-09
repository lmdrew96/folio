/**
 * Folio's additions to the BlockNote editor:
 *   - smartTypography: quotes, dashes, ellipsis and arrows as you type
 *   - attribution: the quiet marginal tick showing who last edited a block
 *   - undoSelection: puts the cursor back where it was on undo/redo (ported
 *     from NugNotes, which hit the same y-prosemirror bug)
 */
import { createExtension, type BlockNoteEditor } from "@blocknote/core";
import {
  AllSelection,
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
  yUndoPluginKey,
  type getRelativeSelection,
} from "y-prosemirror";
import { relativeTime } from "@/lib/time";
import { smartTypography } from "@/superdoc/typography";

// ---------------------------------------------------------------------------
// Smart typography
// ---------------------------------------------------------------------------

/** The last conversion, so Backspace right after it puts back what was typed
 *  (the same escape hatch TipTap's input rules had). */
type LastFix = { from: number; to: number; typed: string } | null;
const typographyKey = new PluginKey<LastFix>("folioTypography");

const typographyPlugin = new Plugin<LastFix>({
  key: typographyKey,
  state: {
    init: () => null,
    apply: (tr, value) => {
      const meta = tr.getMeta(typographyKey) as LastFix | undefined;
      if (meta !== undefined) return meta;
      // Anything else that changes the document, or moves the caret, ends it.
      return tr.docChanged || tr.selectionSet ? null : value;
    },
  },
  props: {
    handleTextInput(view, from, to, text) {
      const { state } = view;
      const $from = state.doc.resolve(from);
      if ($from.parent.type.spec.code) return false; // code blocks stay literal
      if ($from.marks().some((m) => m.type.name === "code")) return false;
      const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼") + text;
      const fix = smartTypography(before);
      if (!fix) return false;
      const start = from - (fix.remove - text.length);
      if (start < $from.start()) return false;
      const typed = before.slice(before.length - fix.remove);
      const tr = state.tr.insertText(fix.insert, start, to);
      tr.setMeta(typographyKey, { from: start, to: start + fix.insert.length, typed });
      view.dispatch(tr);
      return true;
    },
    handleKeyDown(view, event) {
      if (event.key !== "Backspace" || event.metaKey || event.ctrlKey || event.altKey) return false;
      const last = typographyKey.getState(view.state);
      const { selection } = view.state;
      if (!last || !selection.empty || selection.from !== last.to) return false;
      const tr = view.state.tr.insertText(last.typed, last.from, last.to);
      tr.setMeta(typographyKey, null);
      view.dispatch(tr);
      return true;
    },
  },
});

export const smartTypographyExtension = createExtension({
  key: "folioSmartTypography",
  prosemirrorPlugins: [typographyPlugin],
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

export type BlockAttribution = { author: string; name: string; lastEditedAt: number };
type AttributionState = { map: Map<string, BlockAttribution>; decorations: DecorationSet };

const attributionKey = new PluginKey<AttributionState>("folioAttribution");

/** A node decoration per attributed block. Same class and data-author as the
 *  TipTap editor used, so globals.css's `.ProseMirror .folio-attr` rules draw
 *  the tick: hidden for human writers until hover, faintly present for Cleo. */
const buildDecorations = (doc: EditorState["doc"], map: Map<string, BlockAttribution>) => {
  if (map.size === 0) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "blockContainer") return true;
    const a = map.get(node.attrs.id as string);
    if (a) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: "folio-attr",
          "data-author": a.author === "claude" ? "claude" : "human",
          title: `${a.name} · edited ${relativeTime(a.lastEditedAt)}`,
        }),
      );
    }
    return true; // nested blocks have their own ticks
  });
  return DecorationSet.create(doc, decorations);
};

const attributionPlugin = new Plugin<AttributionState>({
  key: attributionKey,
  state: {
    init: () => ({ map: new Map(), decorations: DecorationSet.empty }),
    apply: (tr, value, _old, newState) => {
      const map = tr.getMeta(attributionKey) as Map<string, BlockAttribution> | undefined;
      if (map) return { map, decorations: buildDecorations(newState.doc, map) };
      if (!tr.docChanged) return value;
      return { map: value.map, decorations: value.decorations.map(tr.mapping, tr.doc) };
    },
  },
  props: {
    decorations: (state) => attributionKey.getState(state)?.decorations,
  },
});

export const attributionExtension = createExtension({
  key: "folioAttribution",
  prosemirrorPlugins: [attributionPlugin],
});

/** Hand the editor a fresh blockId → attribution map (no document change, so
 *  it's never saved and never lands in undo history). */
export function setAttribution(
  editor: BlockNoteEditor<any, any, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  map: Map<string, BlockAttribution>,
): void {
  editor.transact((tr) => {
    tr.setMeta(attributionKey, map).setMeta("addToHistory", false);
  });
}

// ---------------------------------------------------------------------------
// Undo selection (from NugNotes src/editor/undo-selection.ts)
// ---------------------------------------------------------------------------
//
// y-prosemirror saves the cursor for each undo step as a Yjs relative
// position. Undoing a change re-creates removed text as new Yjs items, so a
// pointer into removed text (splitting a line with Return) lands elsewhere,
// and the saved spot is only handed over after the undo has redrawn. So each
// undo step also keeps the plain document and selection from just before the
// change; when undo brings the document back to exactly that, the selection
// is restored as-is, otherwise y-prosemirror's relative position is the guess.

type Doc = EditorState["doc"];
type BeforeChange = { doc: Doc; selection: Selection };
type StackItemEvent = { stackItem: { meta: Map<unknown, unknown> } };

const beforeChangeKey = new PluginKey<BeforeChange>("folioBeforeChange");

const undoSelectionPlugin = new Plugin<BeforeChange>({
  key: beforeChangeKey,
  state: {
    init: (_config, state) => ({ doc: state.doc, selection: state.selection }),
    // Transactions plugins append (BlockNote giving a new block its id) keep
    // the state from before the original, or a split is remembered half-done.
    apply: (tr, value, oldState) =>
      tr.getMeta("appendedTransaction") ? value : { doc: oldState.doc, selection: oldState.selection },
  },
  view: (view) => {
    const undoManager = yUndoPluginKey.getState(view.state)?.undoManager;
    if (!undoManager) return {};

    const remember = ({ stackItem }: StackItemEvent) => {
      const beforeChange = beforeChangeKey.getState(view.state);
      if (beforeChange) stackItem.meta.set(beforeChangeKey, beforeChange);
    };

    const restore = ({ stackItem }: StackItemEvent) => {
      const binding = ySyncPluginKey.getState(view.state)?.binding;
      if (binding) {
        // y-prosemirror parks its saved spot on the binding after the undo,
        // so the next remote update would jump the cursor there.
        queueMicrotask(() => {
          binding.beforeTransactionSelection = null;
        });
      }
      const { doc, tr } = view.state;
      const beforeChange = stackItem.meta.get(beforeChangeKey) as BeforeChange | undefined;
      const selection = beforeChange?.doc.eq(doc)
        ? Selection.fromJSON(doc, beforeChange.selection.toJSON())
        : binding && fromRelativeSelection(binding, stackItem.meta.get(binding), doc);
      if (selection) view.dispatch(tr.setSelection(selection).setMeta("addToHistory", false));
    };

    undoManager.on("stack-item-added", remember);
    undoManager.on("stack-item-popped", restore);
    return {
      destroy: () => {
        undoManager.off("stack-item-added", remember);
        undoManager.off("stack-item-popped", restore);
      },
    };
  },
});

type Binding = NonNullable<ReturnType<typeof ySyncPluginKey.getState>>["binding"];

const fromRelativeSelection = (binding: NonNullable<Binding>, saved: unknown, doc: Doc): Selection | null => {
  const relSel = saved as ReturnType<typeof getRelativeSelection> | undefined;
  if (!relSel?.anchor || !relSel.head) return null;
  if (relSel.type === "all") return new AllSelection(doc);
  const anchor = relativePositionToAbsolutePosition(binding.doc, binding.type, relSel.anchor, binding.mapping);
  const head = relativePositionToAbsolutePosition(binding.doc, binding.type, relSel.head, binding.mapping);
  if (anchor === null || head === null) return null;
  if (relSel.type === "node") return NodeSelection.create(doc, anchor);
  return TextSelection.between(doc.resolve(anchor), doc.resolve(head));
};

export const undoSelectionExtension = createExtension({
  key: "folioUndoSelection",
  prosemirrorPlugins: [undoSelectionPlugin],
});
