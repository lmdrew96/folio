/**
 * TipTap document → what SuperDoc imports, plus the check that it arrived
 * intact (migration phase 4; the flow lives in SuperDocEditor).
 *
 * SuperDoc ingests HTML. Two Folio-specific things are rewritten first:
 *   - Footnotes: each reference becomes a placeholder (⟦fn0⟧, ⟦fn1⟧…) and the
 *     footnote blocks at the end are set aside; once imported, each
 *     placeholder is swapped for a real DOCX footnote.
 *   - Highlights: SuperDoc's import turns every highlight into Word yellow,
 *     so highlighted text travels between ⟦hN⟧…⟦/h⟧ markers and is given
 *     its exact colour (Folio's theme names → their tints) afterwards.
 * Then every top-level TipTap block's text must reappear, in order, across
 * the SuperDoc blocks (a TipTap list is one block, but one block per item in
 * SuperDoc) — alignBlocks checks that and records which TipTap block each
 * SuperDoc block came from, so authorship can carry over.
 */

type PMMark = { type: string; attrs?: Record<string, unknown> };
type PMNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: PMMark[];
};

export type LegacyRow = { blockId: string; type: string; content: string };
export type LegacyBlock = { blockId: string; type: string; node: PMNode; text: string };
export type LegacyPlan = {
  blocks: LegacyBlock[];
  /** Footnote text, indexed by placeholder number. */
  footnotes: string[];
  /** Highlight colour, indexed by marker number. */
  highlights: string[];
};

export const footnoteMark = (k: number): string => `⟦fn${k}⟧`;
export const FOOTNOTE_MARK = /⟦fn(\d+)⟧/g;
export const highlightOpen = (k: number): string => `⟦h${k}⟧`;
export const HIGHLIGHT_CLOSE = "⟦/h⟧";
export const HIGHLIGHT_SPAN = /⟦h(\d+)⟧([\s\S]*?)⟦\/h⟧/g;
/** Every marker starts with this; none may survive a conversion. */
export const MARKER_START = "⟦";

/** The light-mode tints behind Folio's highlight names (globals.css). */
const HIGHLIGHT_HEX: Record<string, string> = {
  amber: "#ffd7c3",
  green: "#c6c3ba",
  mint: "#c6c6cb",
  lavender: "#cdc1c8",
};

/** Text with all whitespace removed — what alignment compares. Spacing and
 *  line breaks legitimately shift between editors; the words may not. */
export const squash = (s: string): string => s.replace(/\s+/g, "");

const textOf = (node: PMNode): string =>
  node.text ?? (node.content ?? []).map(textOf).join(" ");

export function planLegacy(rows: LegacyRow[]): LegacyPlan {
  const parsed = rows.map((r) => ({ ...r, node: JSON.parse(r.content) as PMNode }));
  const noteText = new Map<string, string>();
  for (const r of parsed) {
    const id = r.node.attrs?.footnoteId;
    if (r.type === "footnote" && typeof id === "string") noteText.set(id, textOf(r.node).trim());
  }

  const footnotes: string[] = [];
  const highlights: string[] = [];
  const rewrite = (node: PMNode): PMNode[] => {
    if (node.type === "footnoteRef") {
      const text = noteText.get(String(node.attrs?.refId));
      if (text === undefined) return []; // a reference whose note is gone
      footnotes.push(text);
      return [{ type: "text", text: footnoteMark(footnotes.length - 1) }];
    }
    // SuperDoc's HTML import turns any highlight into Word yellow, so the
    // text travels between markers instead and gets its colour afterwards.
    const highlight = node.marks?.find((m) => m.type === "highlight");
    if (node.type === "text" && highlight) {
      const name = highlight.attrs?.color;
      highlights.push(typeof name === "string" ? (HIGHLIGHT_HEX[name] ?? name) : HIGHLIGHT_HEX.amber);
      const marks = node.marks!.filter((m) => m !== highlight);
      return [
        { type: "text", text: highlightOpen(highlights.length - 1) },
        { ...node, marks },
        { type: "text", text: HIGHLIGHT_CLOSE },
      ];
    }
    return [node.content ? { ...node, content: node.content.flatMap(rewrite) } : node];
  };

  const blocks = parsed
    .filter((r) => r.type !== "footnote")
    .map((r) => {
      const node = rewrite(r.node)[0];
      return { blockId: r.blockId, type: r.type, node, text: squash(textOf(node)) };
    });
  return { blocks, footnotes, highlights };
}

export type Alignment =
  | { ok: true; from: Map<string, string> }
  | { ok: false; reason: string };

const snippet = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);

/**
 * Walk the TipTap blocks in order, consuming SuperDoc blocks until their text
 * adds up to each one's. Empty blocks are matched loosely (an empty TipTap
 * paragraph or a rule may or may not survive as an empty SuperDoc block); any
 * text that doesn't line up fails the whole conversion.
 */
export function alignBlocks(
  legacy: { blockId: string; text: string }[],
  converted: { nodeId: string; text: string }[],
): Alignment {
  const from = new Map<string, string>();
  let i = 0;
  for (let b = 0; b < legacy.length; b++) {
    const want = legacy[b].text;
    const id = legacy[b].blockId;
    if (want === "") {
      if (i < converted.length && converted[i].text === "") from.set(converted[i++].nodeId, id);
      continue;
    }
    let got = "";
    while (got.length < want.length) {
      if (i >= converted.length) {
        return { ok: false, reason: `block ${b + 1}: missing "${snippet(want.slice(got.length))}"` };
      }
      const next = got + converted[i].text;
      if (!want.startsWith(next)) {
        return {
          ok: false,
          reason: `block ${b + 1}: expected "${snippet(want.slice(got.length))}", got "${snippet(converted[i].text)}"`,
        };
      }
      got = next;
      from.set(converted[i++].nodeId, id);
    }
  }
  for (; i < converted.length; i++) {
    if (converted[i].text !== "") {
      return { ok: false, reason: `extra text after the last block: "${snippet(converted[i].text)}"` };
    }
    // A trailing empty paragraph: belongs to whoever wrote the last block.
    if (legacy.length) from.set(converted[i].nodeId, legacy[legacy.length - 1].blockId);
  }
  return { ok: true, from };
}
