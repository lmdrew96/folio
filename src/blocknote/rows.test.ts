import { describe, expect, it } from "vitest";
import { blockMarkdown } from "../../convex/blockMarkdown";
import { rowsToBlocks, toRows, type BnBlock, type BnPartial } from "./rows";

const text = (t: string, styles: Record<string, unknown> = {}) => ({ type: "text" as const, text: t, styles });
const block = (id: string, type: string, content: BnBlock["content"], children: BnBlock[] = [], props = {}) => ({
  id,
  type,
  props,
  content,
  children,
});

/** What the MCP door and diff panel would print for each row. */
const markdownOf = (blocks: BnBlock[]) => toRows(blocks).map((r) => blockMarkdown(JSON.parse(r.content)));

/** A PartialBlock as the editor would hand it back (ids filled in). */
const asBlocks = (partials: BnPartial[]): BnBlock[] =>
  partials.map((p, i) => ({
    id: p.id ?? `gen${i}`,
    type: p.type,
    props: p.props ?? {},
    content: p.content as BnBlock["content"],
    children: asBlocks(p.children ?? []),
  }));

describe("toRows", () => {
  it("gives every block — nested list items too — its own row, keyed by its id", () => {
    const doc: BnBlock[] = [
      block("h", "heading", [text("Title")], [], { level: 2 }),
      block("p", "paragraph", [
        text("Some "),
        text("bold", { bold: true }),
        text(" and "),
        { type: "link", href: "https://x.dev", content: [text("a link", { italic: true })] },
        text("\nnext line"),
      ]),
      block("b1", "bulletListItem", [text("first")], [block("b2", "bulletListItem", [text("nested")])]),
      block("n1", "numberedListItem", [text("step")]),
      block("c", "codeBlock", [text("x = `1`")]),
    ];
    expect(toRows(doc).map((r) => r.blockId)).toEqual(["h", "p", "b1", "b2", "n1", "c"]);
    expect(markdownOf(doc)).toEqual([
      "## Title",
      "Some **bold** and [*a link*](https://x.dev)next line",
      "- first",
      "  - nested",
      "1. step",
      "x = `1`",
    ]);
  });

  it("stores colours as style-only marks and code without other marks", () => {
    const [row] = toRows([
      block("p", "paragraph", [text("red", { textColor: "red" }), text("c", { code: true, bold: true })]),
    ]);
    const node = JSON.parse(row.content);
    expect(node.content[0].marks).toEqual([{ type: "textStyle", attrs: { color: "red" } }]);
    expect(node.content[1].marks).toEqual([{ type: "code" }]);
  });

  it("writes a table as the GFM table the readers expect", () => {
    const table = block("t", "table", {
      type: "tableContent",
      rows: [
        { cells: [{ type: "tableCell", content: [text("Name")] }, [text("Age")]] },
        { cells: [[text("Cleo")], [text("1")]] },
      ],
    } as BnBlock["content"]);
    expect(markdownOf([table])).toEqual(["| Name | Age |\n| --- | --- |\n| Cleo | 1 |"]);
  });
});

describe("rowsToBlocks (stored rows → BlockNote)", () => {
  // Rows as the retired SuperDoc extractor wrote them (heading, paragraphs,
  // a bullet list nested three deep, a numbered item) — frozen here when
  // src/superdoc/ was removed; prod documents still carry rows of this shape.
  const rows = [
    {"blockId": "H", "type": "heading", "content": "{\"type\":\"heading\",\"attrs\":{\"level\":1},\"content\":[{\"type\":\"text\",\"text\":\"Plan\"}]}"},
    {"blockId": "P", "type": "paragraph", "content": "{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Intro\"}]}"},
    {"blockId": "A", "type": "bulletList", "content": "{\"type\":\"bulletList\",\"content\":[{\"type\":\"listItem\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"a\"}]}]}]}"},
    {"blockId": "B", "type": "bulletList", "content": "{\"type\":\"bulletList\",\"content\":[{\"type\":\"listItem\",\"content\":[{\"type\":\"bulletList\",\"content\":[{\"type\":\"listItem\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"b\"}]}]}]}]}]}"},
    {"blockId": "C", "type": "bulletList", "content": "{\"type\":\"bulletList\",\"content\":[{\"type\":\"listItem\",\"content\":[{\"type\":\"bulletList\",\"content\":[{\"type\":\"listItem\",\"content\":[{\"type\":\"bulletList\",\"content\":[{\"type\":\"listItem\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"c\"}]}]}]}]}]}]}]}"},
    {"blockId": "D", "type": "bulletList", "content": "{\"type\":\"bulletList\",\"content\":[{\"type\":\"listItem\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"d\"}]}]}]}"},
    {"blockId": "N", "type": "orderedList", "content": "{\"type\":\"orderedList\",\"content\":[{\"type\":\"listItem\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"one\"}]}]}]}"},
    {"blockId": "Q", "type": "paragraph", "content": "{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Outro\"}]}"},
  ];

  it("keeps every id and rebuilds list nesting from the rows' depth", () => {
    const blocks = rowsToBlocks(rows);
    const shape = (bs: BnPartial[]): unknown[] =>
      bs.map((b) => (b.children?.length ? [b.id, b.type, shape(b.children)] : [b.id, b.type]));
    expect(shape(blocks)).toEqual([
      ["H", "heading"],
      ["P", "paragraph"],
      ["A", "bulletListItem", [["B", "bulletListItem", [["C", "bulletListItem"]]]]],
      ["D", "bulletListItem"],
      ["N", "numberedListItem"],
      ["Q", "paragraph"],
    ]);
  });

  it("round-trips: converted rows read the same as the SuperDoc rows", () => {
    const back = toRows(asBlocks(rowsToBlocks(rows)));
    expect(back.map((r) => r.blockId)).toEqual(rows.map((r) => r.blockId));
    expect(back.map((r) => blockMarkdown(JSON.parse(r.content)))).toEqual(
      rows.map((r) => blockMarkdown(JSON.parse(r.content))),
    );
  });

  it("carries formatting, links and line breaks", () => {
    const row = {
      blockId: "x",
      content: JSON.stringify({
        type: "paragraph",
        content: [
          { type: "text", text: "go ", marks: [{ type: "bold" }] },
          { type: "text", text: "here", marks: [{ type: "link", attrs: { href: "https://a.b" } }] },
          { type: "hardBreak" },
          { type: "text", text: "then" },
        ],
      }),
    };
    const [b] = rowsToBlocks([row]);
    expect(b.content).toEqual([
      { type: "text", text: "go ", styles: { bold: true } },
      { type: "link", href: "https://a.b", content: [{ type: "text", text: "here", styles: {} }] },
      { type: "text", text: "\nthen", styles: {} },
    ]);
  });

  it("splits a TipTap-era whole-list row into items, the first keeping the row's id", () => {
    const list = {
      type: "orderedList",
      content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "two" }] },
            {
              type: "bulletList",
              content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "sub" }] }] }],
            },
          ],
        },
      ],
    };
    const blocks = rowsToBlocks([{ blockId: "L", content: list }]);
    expect(blocks.map((b) => [b.id, b.type])).toEqual([
      ["L", "numberedListItem"],
      [undefined, "numberedListItem"],
    ]);
    expect(blocks[1].children?.map((b) => b.type)).toEqual(["bulletListItem"]);
  });
});

describe("toRows fonts", () => {
  it("stores a per-selection font as a style-only textStyle mark, beside any colour", () => {
    const [row] = toRows([block("p", "paragraph", [text("x", { font: "lora", textColor: "red" })])]);
    expect(JSON.parse(row.content).content[0].marks).toEqual([
      { type: "textStyle", attrs: { color: "red", fontFamily: "lora" } },
    ]);
  });
});
