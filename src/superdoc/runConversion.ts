import { toReconcileBlocks, type ReconcileBlock, type SdBlock, type SdProjection } from "./extract";
import {
  alignBlocks,
  FOOTNOTE_MARK,
  HIGHLIGHT_CLOSE,
  HIGHLIGHT_SPAN,
  highlightOpen,
  MARKER_START,
  planLegacy,
  squash,
  type LegacyRow,
} from "./convertLegacy";
import { legacyHtml } from "./legacyHtml";

/**
 * Import a TipTap document into a fresh SuperDoc document and check it
 * (migration phase 4). Pure Document API work — the caller (SuperDocEditor)
 * owns the room, the sync and the Convex calls.
 *
 *   1. Replace the body with the TipTap content as HTML.
 *   2. Check every TipTap block's text reappears, in order (alignBlocks).
 *   3. Blockquotes → the template's Quote style.
 *   4. Highlight markers → the highlight colour on the text between them.
 *   5. Footnote placeholders → real DOCX footnotes.
 *   6. Check no marker is left, and return the block rows to store, each tagged with its TipTap source.
 */

type MaybePromise<T> = T | Promise<T>;
export type ConversionDoc = {
  blocks: { list(input: unknown): MaybePromise<{ blocks: SdBlock[] }> };
  projectMarkdown?(input: unknown): Promise<SdProjection>;
  replace(input: unknown): unknown;
  styles?: { paragraph?: { setStyle(input: unknown): unknown } };
  format?: { apply(input: unknown): unknown };
  footnotes?: {
    insert(input: unknown): unknown;
    list(input?: unknown): MaybePromise<{ total: number }>;
  };
};

export type ConvertedBlock = ReconcileBlock & { from?: string };
export type ConversionResult =
  | { ok: true; blocks: ConvertedBlock[] }
  | { ok: false; reason: string };

const BODY = { kind: "story", storyType: "body" } as const;
const PARAGRAPH_TYPES = new Set(["paragraph", "heading", "listItem"]);

/** Document API mutations report failure in a receipt rather than throwing. */
async function must(result: unknown, what: string): Promise<void> {
  const r = (await result) as { success?: boolean; failure?: unknown } | undefined;
  if (r && r.success === false) {
    throw new Error(`${what} failed: ${JSON.stringify(r.failure ?? r)}`);
  }
}

/** A text range inside one block, in the form `replace`/`format.apply` take. */
const span = (blockId: string, start: number, end: number) => ({
  kind: "selection",
  start: { kind: "text", blockId, offset: start },
  end: { kind: "text", blockId, offset: end },
});

const removeText = (doc: ConversionDoc, blockId: string, start: number, end: number, what: string) =>
  must(doc.replace({ target: span(blockId, start, end), text: "" }), what);

const listBlocks = async (doc: ConversionDoc) =>
  (await doc.blocks.list({ includeText: true, limit: 20_000 })).blocks;

export async function convertInto(doc: ConversionDoc, rows: LegacyRow[]): Promise<ConversionResult> {
  const plan = planLegacy(rows);

  if (plan.blocks.some((b) => b.text !== "")) {
    await must(doc.replace({ target: BODY, type: "html", value: legacyHtml(plan) }), "import");
  }

  const imported = await listBlocks(doc);
  const alignment = alignBlocks(
    plan.blocks,
    imported.map((b) => ({ nodeId: b.nodeId, text: squash(b.text ?? "") })),
  );
  if (!alignment.ok) return { ok: false, reason: `text check: ${alignment.reason}` };
  const from = alignment.from;

  // Blockquotes: HTML import drops their styling; the template has Quote.
  const legacyType = new Map(plan.blocks.map((b) => [b.blockId, b.type]));
  for (const b of imported) {
    const source = from.get(b.nodeId);
    if (!source || legacyType.get(source) !== "blockquote" || !PARAGRAPH_TYPES.has(b.nodeType)) continue;
    try {
      await must(
        doc.styles?.paragraph?.setStyle({
          target: { kind: "block", nodeType: b.nodeType, nodeId: b.nodeId },
          styleId: "Quote",
        }),
        "quote style",
      );
    } catch (e) {
      // Cosmetic — the words are already in. Logged, not fatal.
      console.error("Folio: couldn't style a converted blockquote", e);
    }
  }

  // Highlights, last first within each block so earlier offsets stay valid.
  if (plan.highlights.length) {
    for (const b of await listBlocks(doc)) {
      for (const m of [...(b.text ?? "").matchAll(HIGHLIGHT_SPAN)].reverse()) {
        const k = Number(m[1]);
        const start = m.index;
        const end = start + highlightOpen(k).length + m[2].length; // where ⟦/h⟧ begins
        await removeText(doc, b.nodeId, end, end + HIGHLIGHT_CLOSE.length, "highlight marker removal");
        await removeText(doc, b.nodeId, start, start + highlightOpen(k).length, "highlight marker removal");
        try {
          await must(
            doc.format?.apply({
              target: span(b.nodeId, start, start + m[2].length),
              inline: { highlight: plan.highlights[k] },
            }),
            "highlight",
          );
        } catch (e) {
          // Cosmetic — the words are in. Logged, not fatal.
          console.error("Folio: couldn't restore a highlight", e);
        }
      }
    }
  }

  // Footnotes, likewise last first within each block.
  if (plan.footnotes.length) {
    if (!doc.footnotes) return { ok: false, reason: "footnotes: not supported by this editor" };
    for (const b of await listBlocks(doc)) {
      const marks = [...(b.text ?? "").matchAll(FOOTNOTE_MARK)].reverse();
      for (const m of marks) {
        const at = m.index;
        await removeText(doc, b.nodeId, at, at + m[0].length, "footnote placeholder removal");
        await must(
          doc.footnotes.insert({
            at: { kind: "text", segments: [{ blockId: b.nodeId, range: { start: at, end: at } }] },
            type: "footnote",
            content: plan.footnotes[Number(m[1])],
          }),
          "footnote insert",
        );
      }
    }
    const { total } = await doc.footnotes.list({ type: "footnote" });
    if (total !== plan.footnotes.length) {
      return { ok: false, reason: `footnotes: expected ${plan.footnotes.length}, found ${total}` };
    }
  }

  const final = await listBlocks(doc);
  const leftover = final.find((b) => (b.text ?? "").includes(MARKER_START));
  if (leftover) {
    // e.g. a footnote or highlight inside a table cell, which blocks.list
    // doesn't reach.
    return { ok: false, reason: `a footnote/highlight marker was left in block ${leftover.nodeId}` };
  }
  const projection = doc.projectMarkdown ? await doc.projectMarkdown({}).catch(() => null) : null;
  const blocks = toReconcileBlocks(final, projection).map((r) => ({ ...r, from: from.get(r.blockId) }));
  const orphan = final.find((b) => squash(b.text ?? "") !== "" && !from.has(b.nodeId));
  if (orphan) return { ok: false, reason: `block ${orphan.nodeId} appeared after the text check` };
  return { ok: true, blocks };
}
