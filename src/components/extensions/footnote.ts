import { Extension, Node, mergeAttributes, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** A superscript reference mark in the body text. `n` is the document-order
 *  number (1, 2, 3…) kept in sync by FootnoteSync below — a real node
 *  attribute, not a live-only decoration, so it survives getHTML()/export. */
export const FootnoteReference = Node.create({
  name: "footnoteRef",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      refId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-ref-id"),
        renderHTML: (attrs) => ({ "data-ref-id": attrs.refId }),
      },
      n: {
        default: 0,
        parseHTML: (el) => Number(el.getAttribute("data-n")) || 0,
        renderHTML: (attrs) => ({ "data-n": String(attrs.n) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "sup[data-ref-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["sup", mergeAttributes(HTMLAttributes, { class: "folio-footnote-ref" })];
  },
});

/** The reference-list entry, appended at the end of the document. A regular
 *  top-level block (needs `footnote` in DocEditor's BLOCK_TYPES to get a
 *  UniqueID and sync like any other block) correlated to its FootnoteReference
 *  by `footnoteId` / `refId`. */
export const Footnote = Node.create({
  name: "footnote",
  group: "block",
  content: "inline*",

  addAttributes() {
    return {
      footnoteId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-footnote-id"),
        renderHTML: (attrs) => ({ "data-footnote-id": attrs.footnoteId }),
      },
      n: {
        default: 0,
        parseHTML: (el) => Number(el.getAttribute("data-n")) || 0,
        renderHTML: (attrs) => ({ "data-n": String(attrs.n) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "p[data-footnote-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["p", mergeAttributes(HTMLAttributes, { class: "folio-footnote" }), 0];
  },
});

function jumpTo(view: EditorView, targetType: "footnote" | "footnoteRef", id: string): boolean {
  let target: number | null = null;
  view.state.doc.descendants((node, pos) => {
    if (target !== null) return false;
    const matchId = targetType === "footnote" ? node.attrs.footnoteId : node.attrs.refId;
    if (node.type.name === targetType && matchId === id) {
      target = pos;
      return false;
    }
    return true;
  });
  if (target === null) return false;
  const resolvedPos = Math.min(target + 1, view.state.doc.content.size);
  const tr = view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(resolvedPos)));
  view.dispatch(tr.scrollIntoView());
  return true;
}

const footnoteSyncKey = new PluginKey("folioFootnoteSync");

/** Keeps every footnoteRef's/footnote's `n` attribute equal to its document
 *  order, and silently drops a footnote block once its reference is deleted
 *  — a reference-only delete (backspacing the superscript) shouldn't leave an
 *  orphaned, unlabeled paragraph sitting at the end of the document. Also
 *  wires click-to-jump between a reference and its note. */
export const FootnoteSync = Extension.create({
  name: "folioFootnoteSync",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: footnoteSyncKey,
        props: {
          handleClickOn(view, _pos, node) {
            if (node.type.name === "footnoteRef" && typeof node.attrs.refId === "string") {
              return jumpTo(view, "footnote", node.attrs.refId);
            }
            if (node.type.name === "footnote" && typeof node.attrs.footnoteId === "string") {
              return jumpTo(view, "footnoteRef", node.attrs.footnoteId);
            }
            return false;
          },
        },
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;

          const refIds: string[] = [];
          newState.doc.descendants((node) => {
            if (node.type.name === "footnoteRef" && typeof node.attrs.refId === "string") {
              refIds.push(node.attrs.refId);
            }
            return true;
          });
          const numberById = new Map(refIds.map((id, i) => [id, i + 1]));

          let tr: Transaction | null = null;
          const orphanRanges: { from: number; to: number }[] = [];

          newState.doc.descendants((node, pos) => {
            if (node.type.name === "footnoteRef") {
              const n = numberById.get(node.attrs.refId as string) ?? 0;
              if (node.attrs.n !== n) {
                tr = (tr ?? newState.tr).setNodeAttribute(pos, "n", n);
              }
            } else if (node.type.name === "footnote") {
              const n = numberById.get(node.attrs.footnoteId as string);
              if (n === undefined) {
                orphanRanges.push({ from: pos, to: pos + node.nodeSize });
              } else if (node.attrs.n !== n) {
                tr = (tr ?? newState.tr).setNodeAttribute(pos, "n", n);
              }
            }
            return true;
          });

          if (orphanRanges.length > 0) {
            tr = tr ?? newState.tr;
            for (let i = orphanRanges.length - 1; i >= 0; i--) {
              tr.delete(orphanRanges[i].from, orphanRanges[i].to);
            }
          }

          return tr;
        },
      }),
    ];
  },
});

/** Inserts a reference at the cursor and appends its (empty) note at the end
 *  of the document, then moves the cursor into the note to write it — one
 *  undo step, matching how most editors introduce a footnote. */
export function insertFootnote(editor: Editor): void {
  const refId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `fn-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  editor
    .chain()
    .focus()
    .command(({ tr, dispatch }) => {
      if (!dispatch) return true;
      const { schema } = tr.doc.type;
      const insertAt = tr.selection.to;
      const refNode = schema.nodes.footnoteRef.create({ refId, n: 0 });
      // A code block (or similar restricted content) can't hold an inline
      // atom — fail the command instead of throwing mid-transaction.
      try {
        tr.insert(insertAt, refNode);
      } catch {
        return false;
      }

      const footnoteNode = schema.nodes.footnote.create({ footnoteId: refId, n: 0 });
      const endPos = tr.doc.content.size;
      tr.insert(endPos, footnoteNode);

      const insidePos = Math.min(endPos + 1, tr.doc.content.size);
      tr.setSelection(TextSelection.near(tr.doc.resolve(insidePos)));
      tr.scrollIntoView();
      return true;
    })
    .run();
}
