// @vitest-environment jsdom
// (BlockNote's markdown parser needs a DOM, as it has in the browser.)
import { describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { rowsToBlocks, toRows, type BnBlock } from "./rows";

const SHEET = `## Key concepts

- **Interlanguage** — a learner's evolving system ([Week 2 · Sep 9](/doc/abc))
  - fossilization when it stops moving

## Likely exam questions

1. What drives fossilization?
2. How does input differ from intake? ([Week 3 · Sep 16](/doc/def))

| Term | Note |
| --- | --- |
| Intake | Week 3 |
`;

describe("review sheet rows", () => {
  it("seed the editor back into the same rows, so the sheet stays Cleo's", async () => {
    const parsed = await BlockNoteEditor.create().tryParseMarkdownToBlocks(SHEET);
    const rows = toRows(parsed as unknown as BnBlock[]);
    expect(rows.length).toBeGreaterThan(5);

    // What BlockNoteEditor does on first open of a server-written document.
    const editor = BlockNoteEditor.create();
    editor.replaceBlocks(editor.document, rowsToBlocks(rows) as Parameters<typeof editor.replaceBlocks>[1]);
    const seeded = toRows(editor.document as unknown as BnBlock[]);

    expect(seeded.map((r) => [r.blockId, r.type, r.content])).toEqual(
      rows.map((r) => [r.blockId, r.type, r.content]),
    );
  });
});
