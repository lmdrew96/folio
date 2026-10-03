import { describe, expect, it } from "vitest";
import { toReconcileBlocks, type SdBlock, type SdProjection } from "./extract";

/** Build a projection from per-block markdown, laid out like SuperDoc's. */
function projection(parts: [string, string][]): SdProjection {
  let content = "";
  const blocks: SdProjection["blocks"] = [];
  for (const [blockId, md] of parts) {
    const start = content.length;
    content += md;
    blocks.push({ blockId, output: { start, end: content.length } });
    content += "\n\n";
  }
  return { content, blocks };
}

const block = (nodeId: string, nodeType: string, extra: Partial<SdBlock> = {}): SdBlock => ({
  nodeId,
  nodeType,
  textPreview: null,
  ...extra,
});

const content = (rows: ReturnType<typeof toReconcileBlocks>, i: number) =>
  JSON.parse(rows[i].content);

/** A list item's slice exactly as SuperDoc 2.18 projects it: HTML, not markdown. */
const li = (label: string, inner: string) =>
  `<li style="list-style-type:none"><span data-superdoc-list-label data-superdoc-list-suffix="tab">${label}&#9;</span>${inner}</li>`;

describe("toReconcileBlocks", () => {
  it("carries inline formatting into ProseMirror marks", () => {
    const rows = toReconcileBlocks(
      [block("p1", "paragraph")],
      projection([
        ["p1", "Plain **bold** *it* ~~gone~~ `code` <u>under</u> [link](https://x.test)"],
      ]),
    );
    expect(content(rows, 0)).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "Plain " },
        { type: "text", text: "bold", marks: [{ type: "bold" }] },
        { type: "text", text: " " },
        { type: "text", text: "it", marks: [{ type: "italic" }] },
        { type: "text", text: " " },
        { type: "text", text: "gone", marks: [{ type: "strike" }] },
        { type: "text", text: " " },
        { type: "text", text: "code", marks: [{ type: "code" }] },
        { type: "text", text: " " },
        { type: "text", text: "under", marks: [{ type: "underline" }] },
        { type: "text", text: " " },
        { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://x.test" } }] },
      ],
    });
  });

  it("nests marks (bold inside a link)", () => {
    const rows = toReconcileBlocks(
      [block("p1", "paragraph")],
      projection([["p1", "[**strong link**](https://x.test)"]]),
    );
    expect(content(rows, 0).content).toEqual([
      {
        type: "text",
        text: "strong link",
        marks: [{ type: "link", attrs: { href: "https://x.test" } }, { type: "bold" }],
      },
    ]);
  });

  it("keeps heading levels and rebuilds list nesting from numbering depth", () => {
    const rows = toReconcileBlocks(
      [
        block("h", "heading", { headingLevel: 2 }),
        block("l1", "listItem", { numbering: { marker: "•", path: [1], kind: "bullet" } }),
        block("l3", "listItem", { numbering: { marker: "1.", path: [1, 1, 2], kind: "ordered" } }),
      ],
      projection([
        ["h", "## What she *packed*"],
        ["l1", li("•", "Rope")],
        ["l3", li("1.", "Checked <strong>twice</strong>")],
      ]),
    );
    expect(content(rows, 0)).toEqual({
      type: "heading",
      attrs: { level: 2 },
      content: [
        { type: "text", text: "What she " },
        { type: "text", text: "packed", marks: [{ type: "italic" }] },
      ],
    });
    expect(rows[1].type).toBe("bulletList");
    // Three levels deep: list > item > list > item > list > item > paragraph.
    const l3 = content(rows, 2);
    expect(l3.type).toBe("orderedList");
    const item3 = l3.content[0].content[0].content[0].content[0].content[0];
    expect(item3.type).toBe("listItem");
    expect(item3.content[0]).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "Checked " },
        { type: "text", text: "twice", marks: [{ type: "bold" }] },
      ],
    });
  });

  it("reads a list item's own text and marks, not its label or nested items", () => {
    const rows = toReconcileBlocks(
      [
        block("p", "listItem", {
          text: "Second",
          numbering: { marker: "•", path: [2], kind: "bullet" },
        }),
        block("c", "listItem", {
          text: "a & b link code",
          numbering: { marker: "◦", path: [2, 1], kind: "bullet" },
        }),
      ],
      projection([
        [
          "p",
          li("•", `Second<ul data-superdoc-list-labels="explicit">${li("◦", "Nested")}</ul>`),
        ],
        [
          "c",
          li(
            "◦",
            `<em>a &amp; b</em> <a href="https://x.test/?a=1&amp;b=2"><strong>link</strong></a> <code>code</code>`,
          ),
        ],
      ]),
    );
    expect(content(rows, 0).content[0].content[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "Second" }],
    });
    const child = content(rows, 1).content[0].content[0].content[0].content[0];
    expect(child).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "a & b", marks: [{ type: "italic" }] },
        { type: "text", text: " " },
        {
          type: "text",
          text: "link",
          marks: [{ type: "link", attrs: { href: "https://x.test/?a=1&b=2" } }, { type: "bold" }],
        },
        { type: "text", text: " " },
        { type: "text", text: "code", marks: [{ type: "code" }] },
      ],
    });
  });

  it("falls back to plain text when a slice parses to nothing", () => {
    const rows = toReconcileBlocks(
      [block("x", "paragraph", { text: "still here" })],
      projection([["x", "<div></div>"]]),
    );
    expect(content(rows, 0).content).toEqual([{ type: "text", text: "still here" }]);
  });

  it("turns a table slice into a ProseMirror table with a header row", () => {
    const rows = toReconcileBlocks(
      [block("tbl:1", "table", { text: "HourTide04:10Low" })],
      projection([["tbl:1", "| Hour | Tide |\n| --- | --- |\n| 04:10 | **Low** |"]]),
    );
    const table = content(rows, 0);
    expect(table.type).toBe("table");
    expect(table.content[0].content[0]).toEqual({
      type: "tableHeader",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hour" }] }],
    });
    expect(table.content[1].content[1].content[0].content).toEqual([
      { type: "text", text: "Low", marks: [{ type: "bold" }] },
    ]);
  });

  it("falls back to plain text when a block has no markdown slice", () => {
    const rows = toReconcileBlocks(
      [block("p1", "paragraph", { text: "just text" }), block("empty", "paragraph", { text: "" })],
      null,
    );
    expect(content(rows, 0).content).toEqual([{ type: "text", text: "just text" }]);
    expect(content(rows, 1)).toEqual({ type: "paragraph", content: [] });
  });

  it("keeps block ids and order", () => {
    const rows = toReconcileBlocks(
      [block("b", "paragraph"), block("a", "paragraph")],
      projection([
        ["a", "second"],
        ["b", "first"],
      ]),
    );
    expect(rows.map((r) => r.blockId)).toEqual(["b", "a"]);
    expect(content(rows, 0).content[0].text).toBe("first");
  });
});
