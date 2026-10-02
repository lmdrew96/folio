import { describe, expect, it } from "vitest";
import { alignBlocks, planLegacy, squash, type LegacyRow } from "./convertLegacy";

const row = (blockId: string, node: object): LegacyRow => ({
  blockId,
  type: (node as { type: string }).type,
  content: JSON.stringify(node),
});
const p = (...content: object[]) => ({ type: "paragraph", content });
const text = (t: string, marks?: object[]) => (marks ? { type: "text", text: t, marks } : { type: "text", text: t });

describe("planLegacy", () => {
  it("swaps footnote references for numbered placeholders and sets the notes aside", () => {
    const plan = planLegacy([
      row("a", p(text("Claim"), { type: "footnoteRef", attrs: { refId: "f1", n: 1 } }, text(" more"))),
      row("b", p(text("Another"), { type: "footnoteRef", attrs: { refId: "f2", n: 2 } })),
      row("n1", { type: "footnote", attrs: { footnoteId: "f1" }, content: [text("Source one")] }),
      row("n2", { type: "footnote", attrs: { footnoteId: "f2" }, content: [text("Source two")] }),
    ]);
    expect(plan.footnotes).toEqual(["Source one", "Source two"]);
    expect(plan.blocks.map((b) => b.blockId)).toEqual(["a", "b"]);
    expect(plan.blocks[0].text).toBe("Claim⟦fn0⟧more");
    expect(plan.blocks[1].text).toBe("Another⟦fn1⟧");
  });

  it("drops a reference whose note is gone", () => {
    const plan = planLegacy([row("a", p(text("x"), { type: "footnoteRef", attrs: { refId: "nope" } }))]);
    expect(plan.footnotes).toEqual([]);
    expect(plan.blocks[0].text).toBe("x");
  });

  it("wraps highlighted text in numbered markers with its colour", () => {
    const plan = planLegacy([
      row("a", p(text("Some "), text("hi", [{ type: "highlight", attrs: { color: "amber" } }, { type: "bold" }]))),
      row("b", p(text("yo", [{ type: "highlight", attrs: { color: "#abcdef" } }]))),
    ]);
    expect(plan.highlights).toEqual(["#ffd7c3", "#abcdef"]);
    expect(plan.blocks[0].node.content).toEqual([
      text("Some "),
      text("⟦h0⟧"),
      text("hi", [{ type: "bold" }]),
      text("⟦/h⟧"),
    ]);
    expect(plan.blocks[1].text).toBe("⟦h1⟧yo⟦/h⟧");
  });

  it("reads a whole list's text as one block", () => {
    const list = {
      type: "bulletList",
      content: [
        { type: "listItem", content: [p(text("one"))] },
        { type: "listItem", content: [p(text("two"))] },
      ],
    };
    expect(planLegacy([row("l", list)]).blocks[0].text).toBe("onetwo");
  });
});

describe("alignBlocks", () => {
  const legacy = (...texts: string[]) => texts.map((t, i) => ({ blockId: `old${i}`, text: squash(t) }));
  const converted = (...texts: string[]) => texts.map((t, i) => ({ nodeId: `new${i}`, text: squash(t) }));

  it("maps list items back to the list they came from", () => {
    const result = alignBlocks(legacy("Title", "one two"), converted("Title", "one", "two"));
    expect(result).toEqual({
      ok: true,
      from: new Map([["new0", "old0"], ["new1", "old1"], ["new2", "old1"]]),
    });
  });

  it("ignores whitespace differences", () => {
    expect(alignBlocks(legacy("a  b\nc"), converted("a b c")).ok).toBe(true);
  });

  it("matches empty blocks loosely", () => {
    // An empty paragraph kept, a rule dropped, a trailing empty paragraph added.
    const result = alignBlocks(legacy("a", "", "", "b"), converted("a", "", "b", ""));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.from.get("new3")).toBe("old3");
  });

  it("fails on changed, missing or extra text", () => {
    expect(alignBlocks(legacy("hello"), converted("help"))).toMatchObject({ ok: false });
    expect(alignBlocks(legacy("a", "b"), converted("a"))).toMatchObject({ ok: false });
    expect(alignBlocks(legacy("a"), converted("a", "b"))).toMatchObject({ ok: false });
  });
});
