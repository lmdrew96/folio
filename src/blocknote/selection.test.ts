import { describe, expect, it } from "vitest";
import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { selectionText } from "./rows";

// Same rule as the footer's countWords (SuperDocFooter.tsx).
const countWords = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);

const p = (text: string) => ({ type: "paragraph" as const, content: text });

const editorWith = (blocks: PartialBlock[]) => BlockNoteEditor.create({ initialContent: blocks });

describe("selectionText", () => {
  it("counts every word when a select-all spans paragraphs, a heading and a list", () => {
    const editor = editorWith([
      { type: "heading", content: "A title", props: { level: 2 } },
      p("The first paragraph ends with millions."),
      p("I didn't stop there."),
      { type: "bulletListItem", content: "one item", children: [{ type: "bulletListItem", content: "nested item" }] },
    ]);
    const doc = editor.prosemirrorState.doc;
    // The footer's total, block by block: 2 + 6 + 4 + 2 + 2.
    expect(countWords(selectionText(doc, 0, doc.content.size))).toBe(16);
  });

  it("counts both boundary words when a partial selection crosses a paragraph break", () => {
    const editor = editorWith([p("alpha beta"), p("gamma delta")]);
    const doc = editor.prosemirrorState.doc;
    // From inside "beta" to inside "gamma": "ta" + "gam" are two words.
    let from = -1;
    let to = -1;
    doc.descendants((node, pos) => {
      if (!node.isText) return;
      if (node.text === "alpha beta") from = pos + "alpha be".length;
      if (node.text === "gamma delta") to = pos + "gam".length;
    });
    expect(countWords(selectionText(doc, from, to))).toBe(2);
  });
});
