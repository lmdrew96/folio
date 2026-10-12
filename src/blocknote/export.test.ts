import { describe, expect, it } from "vitest";
import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { toMarkdown } from "../lib/export";
import { toTipTapDoc, type BnBlock } from "./rows";

const docOf = (blocks: PartialBlock[]) =>
  toTipTapDoc(BlockNoteEditor.create({ initialContent: blocks }).document as unknown as BnBlock[]);

describe("toTipTapDoc → Markdown", () => {
  it("keeps headings, nested lists, marks, links and tables", () => {
    const doc = docOf([
      { type: "heading", props: { level: 2 }, content: "Plan" },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Read ", styles: {} },
          { type: "text", text: "this", styles: { bold: true } },
          { type: "text", text: " and ", styles: {} },
          { type: "link", href: "https://x.dev", content: [{ type: "text", text: "that", styles: { italic: true } }] },
        ],
      },
      { type: "bulletListItem", content: "one", children: [{ type: "bulletListItem", content: "one.a" }] },
      { type: "bulletListItem", content: "two" },
      { type: "numberedListItem", props: { start: 3 }, content: "third" },
      { type: "numberedListItem", content: "fourth" },
      { type: "checkListItem", props: { checked: true }, content: "done" },
      {
        type: "table",
        content: {
          type: "tableContent",
          rows: [{ cells: ["Name", "Words"] }, { cells: ["Essay", "330"] }],
        },
      },
    ]);
    expect(toMarkdown(doc)).toBe(
      [
        "## Plan",
        "Read **this** and [*that*](https://x.dev)",
        "- one\n  - one.a\n- two",
        "3. third\n4. fourth",
        "- ☑ done",
        "| Name | Words |\n| --- | --- |\n| Essay | 330 |",
      ].join("\n\n") + "\n",
    );
  });
});
