import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import type { Nodes, PhrasingContent, Root, Table } from "mdast";

/**
 * SuperDoc document → the block rows `api.blocks.reconcile` accepts.
 *
 * Under SuperDoc the Y.Doc is the source of truth and `blocks` is a derived
 * copy, kept so the diff panel, attribution, Cleo and the MCP door keep
 * reading the TipTap-shaped JSON they already understand. Two Document API
 * reads feed it:
 *   - `blocks.list`      — each top-level block's id, type, heading level and
 *                          list nesting (DOCX list items are flat paragraphs)
 *   - `projectMarkdown`  — the formatted text, with a map from block id to
 *                          its slice of the markdown
 * The markdown slice is parsed back into ProseMirror marks (bold, italic,
 * strike, underline, code, links) and tables. A block with no slice falls
 * back to its plain text, so extraction degrades rather than drops content.
 */

// Minimal slices of SuperDoc's document-api types (blocks.types / content-projection).
export type SdBlock = {
  nodeId: string;
  nodeType: string;
  text?: string | null;
  textPreview: string | null;
  headingLevel?: number;
  numbering?: { marker: string; path: number[]; kind: "ordered" | "bullet" };
};
export type SdProjection = {
  content: string;
  blocks: { blockId?: string; output: { start: number; end: number } }[];
};

type PMMark = { type: string; attrs?: Record<string, unknown> };
type PMNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: PMMark[];
};

export type ReconcileBlock = { blockId: string; type: string; content: string };

const parse = (md: string): Root =>
  fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });

const textNode = (text: string, marks: PMMark[]): PMNode =>
  marks.length ? { type: "text", text, marks } : { type: "text", text };

/** mdast inline content → ProseMirror inline nodes. Underline has no markdown
 *  syntax, so it arrives as inline `<u>`/`</u>` HTML and toggles a mark across
 *  the siblings between them. */
function inline(nodes: PhrasingContent[], marks: PMMark[] = []): PMNode[] {
  const out: PMNode[] = [];
  let underline = false;
  for (const n of nodes) {
    const active = underline ? [...marks, { type: "underline" }] : marks;
    switch (n.type) {
      case "text":
        if (n.value) out.push(textNode(n.value, active));
        break;
      case "strong":
        out.push(...inline(n.children, [...active, { type: "bold" }]));
        break;
      case "emphasis":
        out.push(...inline(n.children, [...active, { type: "italic" }]));
        break;
      case "delete":
        out.push(...inline(n.children, [...active, { type: "strike" }]));
        break;
      case "inlineCode":
        // TipTap's code mark excludes all others, so it carries no siblings.
        out.push(textNode(n.value, [{ type: "code" }]));
        break;
      case "link":
        out.push(...inline(n.children, [...active, { type: "link", attrs: { href: n.url } }]));
        break;
      case "break":
        out.push({ type: "hardBreak" });
        break;
      case "html":
        if (/^<u>$/i.test(n.value.trim())) underline = true;
        else if (/^<\/u>$/i.test(n.value.trim())) underline = false;
        break;
      default:
        // Images, footnote refs etc.: keep any text they carry.
        if ("children" in n) out.push(...inline(n.children as PhrasingContent[], active));
        else if ("value" in n && typeof n.value === "string" && n.value) {
          out.push(textNode(n.value, active));
        }
    }
  }
  return out;
}

/** The inline content of the first paragraph/heading in a markdown slice.
 *  Leading indentation is stripped first: a deep list item's slice arrives
 *  indented, and 4+ spaces would otherwise parse as a code block. Each slice
 *  is parsed alone, so the indent carries no meaning here — nesting depth
 *  comes from the block's numbering path instead. */
function inlineOf(md: string): PMNode[] {
  const stack: Nodes[] = [parse(md.trimStart())];
  while (stack.length) {
    const n = stack.shift()!;
    if (n.type === "paragraph" || n.type === "heading") return inline(n.children);
    if ("children" in n) stack.unshift(...(n.children as Nodes[]));
  }
  return [];
}

function tableOf(md: string): PMNode | null {
  const table = parse(md).children.find((n): n is Table => n.type === "table");
  if (!table) return null;
  return {
    type: "table",
    content: table.children.map((row, r) => ({
      type: "tableRow",
      content: row.children.map((cell) => ({
        type: r === 0 ? "tableHeader" : "tableCell",
        content: [{ type: "paragraph", content: inline(cell.children) }],
      })),
    })),
  };
}

const plain = (text: string): PMNode[] => (text ? [{ type: "text", text }] : []);

/** A DOCX list paragraph is flat; rebuild the nesting Folio's readers expect
 *  (list > listItem > list > listItem > paragraph) from its numbering depth. */
function listNode(content: PMNode[], kind: "ordered" | "bullet", depth: number): PMNode {
  const listType = kind === "ordered" ? "orderedList" : "bulletList";
  let node: PMNode = { type: "paragraph", content };
  for (let d = 0; d < depth; d++) {
    node = { type: listType, content: [{ type: "listItem", content: [node] }] };
  }
  return node;
}

function toNode(b: SdBlock, md: string | undefined): PMNode {
  const text = b.text ?? b.textPreview ?? "";
  const content = md !== undefined ? inlineOf(md) : plain(text);
  switch (b.nodeType) {
    case "heading":
      return { type: "heading", attrs: { level: b.headingLevel ?? 1 }, content };
    case "listItem":
      return b.numbering
        ? listNode(content, b.numbering.kind, Math.max(1, b.numbering.path.length))
        : { type: "paragraph", content };
    case "table":
      return (md !== undefined && tableOf(md)) || { type: "paragraph", content: plain(text) };
    default:
      return { type: "paragraph", content };
  }
}

export function toReconcileBlocks(
  blocks: SdBlock[],
  projection: SdProjection | null,
): ReconcileBlock[] {
  const mdById = new Map<string, string>();
  for (const p of projection?.blocks ?? []) {
    if (p.blockId) mdById.set(p.blockId, projection!.content.slice(p.output.start, p.output.end));
  }
  return blocks.map((b) => {
    const node = toNode(b, mdById.get(b.nodeId));
    return { blockId: b.nodeId, type: node.type, content: JSON.stringify(node) };
  });
}
