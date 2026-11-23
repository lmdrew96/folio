import { describe, expect, it } from "vitest";
import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { blockText } from "../../convex/blockMarkdown";
import { blockPlainText, flatten, selectionText, toRows, type BnBlock } from "./rows";

// Same rule as countWords in components/EditorToolbar.tsx.
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

  it("counts table text the same in the footer, a select-all and the application check", () => {
    const editor = editorWith([
      p("Intro line here."),
      {
        type: "table",
        content: { type: "tableContent", rows: [{ cells: ["Name", "Words"] }, { cells: ["Personal statement", "330"] }] },
      },
    ]);
    const doc = editor.prosemirrorState.doc;
    const blocks = editor.document as unknown as BnBlock[];
    // The footer's total (BlockNoteEditor), the server's (documents.applicationCheck).
    const footer = flatten(blocks).reduce((n, b) => n + countWords(blockPlainText(b)), 0);
    const server = countWords(toRows(blocks).map((r) => blockText(JSON.parse(r.content))).join(" "));
    expect(footer).toBe(8);
    expect(countWords(selectionText(doc, 0, doc.content.size))).toBe(footer);
    expect(server).toBe(footer);
  });
});
