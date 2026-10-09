/**
 * BlockNote blocks ⇄ Folio's block rows.
 *
 * Under BlockNote the Y.Doc is the source of truth and `blocks` is a derived
 * copy, kept so the diff panel, attribution, Cleo and the MCP door keep
 * reading the TipTap-shaped JSON they already understand (see
 * convex/blockMarkdown.ts). Unlike SuperDoc there's no projection to parse:
 * every BlockNote block — nested list items included — already has its own
 * stable id and structured content, so each one maps straight to one row.
 *
 *   toRows        editor.document → rows (flattened, document order)
 *   rowsToBlocks  SuperDoc-derived rows → BlockNote blocks, ids kept (conversion)
 */

// Minimal structural slices of BlockNote's types — the editor's own generics
// are schema-dependent and don't add safety here.
type Styles = Record<string, unknown>;
export type BnText = { type: "text"; text: string; styles: Styles };
export type BnLink = { type: "link"; href: string; content: BnText[] };
type BnInline = BnText | BnLink | { type: string; [k: string]: unknown };
type BnCell = BnInline[] | { type: "tableCell"; content: BnInline[] };
type BnTable = { type: "tableContent"; rows: { cells: BnCell[] }[]; headerRows?: number };
export type BnBlock = {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: BnInline[] | BnTable;
  children: BnBlock[];
};
/** What `rowsToBlocks` produces — a BlockNote PartialBlock. */
export type BnPartial = {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: BnInline[] | { type: "tableContent"; rows: { cells: BnInline[][] }[] };
  children?: BnPartial[];
};

type PMMark = { type: string; attrs?: Record<string, unknown> };
export type PMNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: PMMark[];
};

export type ReconcileBlock = { blockId: string; type: string; content: string };

// ---------------------------------------------------------------------------
// BlockNote → rows
// ---------------------------------------------------------------------------

/** BlockNote style → ProseMirror mark. Colours become the style-only marks
 *  reconcile ignores when deciding what counts as an edit. */
const marksOf = (styles: Styles): PMMark[] => {
  const marks: PMMark[] = [];
  if (styles.bold) marks.push({ type: "bold" });
  if (styles.italic) marks.push({ type: "italic" });
  if (styles.underline) marks.push({ type: "underline" });
  if (styles.strike) marks.push({ type: "strike" });
  // Colour and font share TipTap's textStyle mark, as they did there.
  const textStyle: Record<string, unknown> = {};
  if (typeof styles.textColor === "string" && styles.textColor !== "default") textStyle.color = styles.textColor;
  if (typeof styles.font === "string" && styles.font) textStyle.fontFamily = styles.font;
  if (Object.keys(textStyle).length) marks.push({ type: "textStyle", attrs: textStyle });
  if (typeof styles.backgroundColor === "string" && styles.backgroundColor !== "default") {
    marks.push({ type: "highlight", attrs: { color: styles.backgroundColor } });
  }
  // TipTap's code mark excludes every other mark (blockMarkdown relies on it).
  return styles.code ? [{ type: "code" }] : marks;
};

/** A text run → text nodes, with BlockNote's "\n" soft breaks as hardBreaks. */
const textNodes = (text: string, marks: PMMark[]): PMNode[] => {
  const out: PMNode[] = [];
  text.split("\n").forEach((part, i) => {
    if (i > 0) out.push({ type: "hardBreak" });
    if (part) out.push(marks.length ? { type: "text", text: part, marks } : { type: "text", text: part });
  });
  return out;
};

export function inlineToPM(content: BnInline[] | undefined): PMNode[] {
  const out: PMNode[] = [];
  for (const n of content ?? []) {
    if (n.type === "text") {
      const t = n as BnText;
      out.push(...textNodes(t.text, marksOf(t.styles ?? {})));
    } else if (n.type === "link") {
      const l = n as BnLink;
      for (const t of l.content ?? []) {
        const marks = marksOf(t.styles ?? {});
        // code excludes link too, as in TipTap
        const withLink = marks.some((m) => m.type === "code")
          ? marks
          : [...marks, { type: "link", attrs: { href: l.href } }];
        out.push(...textNodes(t.text, withLink));
      }
    }
    // Other inline types (none in the default schema) carry no text.
  }
  return out;
}

const cellInline = (cell: BnCell): BnInline[] => (Array.isArray(cell) ? cell : (cell.content ?? []));

/** Wrap an item in `depth` list levels — the same shape src/superdoc/extract.ts
 *  writes for a DOCX list paragraph, which blockMarkdown renders indented. */
const listNode = (content: PMNode[], listType: string, depth: number): PMNode => {
  let node: PMNode = { type: "paragraph", content };
  for (let d = 0; d < depth; d++) node = { type: listType, content: [{ type: "listItem", content: [node] }] };
  return node;
};

const LIST_TYPES: Record<string, string> = {
  bulletListItem: "bulletList",
  numberedListItem: "orderedList",
  checkListItem: "bulletList",
  toggleListItem: "bulletList",
};

/** One block (not its children) → the TipTap-shaped node its row stores.
 *  `listDepth` is how many list items enclose it, itself included. */
export function blockToPM(block: BnBlock, listDepth: number): PMNode {
  const inline = Array.isArray(block.content) ? inlineToPM(block.content) : [];
  const listType = LIST_TYPES[block.type];
  if (listType) return listNode(inline, listType, Math.max(1, listDepth));
  switch (block.type) {
    case "heading":
      return { type: "heading", attrs: { level: Number(block.props.level) || 1 }, content: inline };
    case "quote":
      return { type: "blockquote", content: [{ type: "paragraph", content: inline }] };
    case "codeBlock":
      return { type: "codeBlock", content: inline };
    case "table": {
      const table = block.content as BnTable | undefined;
      const headerRows = table?.headerRows ?? 1;
      return {
        type: "table",
        content: (table?.rows ?? []).map((row, r) => ({
          type: "tableRow",
          content: row.cells.map((cell) => ({
            type: r < headerRows ? "tableHeader" : "tableCell",
            content: [{ type: "paragraph", content: inlineToPM(cellInline(cell)) }],
          })),
        })),
      };
    }
    case "image":
    case "video":
    case "audio":
    case "file": {
      // No inline content; keep whatever names it so it still reads as text.
      const label = String(block.props.caption || block.props.name || block.props.url || "");
      return { type: "paragraph", content: label ? [{ type: "text", text: label }] : [] };
    }
    case "divider":
      return { type: "horizontalRule" };
    default:
      return { type: "paragraph", content: inline };
  }
}

/** The whole document → one row per block, nested ones included, in reading
 *  order. A row's id is the BlockNote block id. */
export function toRows(blocks: BnBlock[]): ReconcileBlock[] {
  const rows: ReconcileBlock[] = [];
  const walk = (list: BnBlock[], listDepth: number) => {
    for (const b of list) {
      const depth = LIST_TYPES[b.type] ? listDepth + 1 : listDepth;
      const node = blockToPM(b, depth);
      rows.push({ blockId: b.id, type: node.type, content: JSON.stringify(node) });
      walk(b.children ?? [], depth);
    }
  };
  walk(blocks, 0);
  return rows;
}

/** Plain text of a block's own line (not its children) — word count, outline. */
export const blockPlainText = (b: BnBlock): string =>
  Array.isArray(b.content)
    ? b.content
        .map((n) => (n.type === "text" ? (n as BnText).text : n.type === "link" ? (n as BnLink).content.map((t) => t.text).join("") : ""))
        .join("")
    : "";

/** Every block in reading order, nested ones included. */
export function flatten(blocks: BnBlock[]): BnBlock[] {
  const out: BnBlock[] = [];
  const walk = (list: BnBlock[]) => {
    for (const b of list) {
      out.push(b);
      walk(b.children ?? []);
    }
  };
  walk(blocks);
  return out;
}

// ---------------------------------------------------------------------------
// rows → BlockNote (conversion)
// ---------------------------------------------------------------------------

/** ProseMirror inline nodes → BlockNote inline content. Consecutive runs with
 *  the same link become one link; hardBreaks become "\n". */
export function pmToInline(nodes: PMNode[] | undefined): BnInline[] {
  const out: BnInline[] = [];
  for (const n of nodes ?? []) {
    let text: string;
    if (n.type === "hardBreak") text = "\n";
    else if (typeof n.text === "string") text = n.text;
    else continue;
    const styles: Styles = {};
    let href: string | undefined;
    for (const m of n.marks ?? []) {
      if (m.type === "bold" || m.type === "italic" || m.type === "underline" || m.type === "strike" || m.type === "code") {
        styles[m.type] = true;
      } else if (m.type === "link" && typeof m.attrs?.href === "string") {
        href = m.attrs.href;
      }
    }
    const run: BnText = { type: "text", text, styles };
    const last = out[out.length - 1];
    if (href) {
      if (last?.type === "link" && (last as BnLink).href === href) (last as BnLink).content.push(run);
      else out.push({ type: "link", href, content: [run] });
    } else if (last?.type === "text" && sameStyles((last as BnText).styles, styles)) {
      (last as BnText).text += text;
    } else {
      out.push(run);
    }
  }
  return out;
}

const sameStyles = (a: Styles, b: Styles): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

/** First paragraph/heading's inline content anywhere under a node. */
const firstLine = (node: PMNode): PMNode[] | undefined => {
  if (node.type === "paragraph" || node.type === "heading") return node.content ?? [];
  for (const c of node.content ?? []) {
    if (c.type === "bulletList" || c.type === "orderedList") continue;
    const found = firstLine(c);
    if (found) return found;
  }
  return undefined;
};

/** A block with the level it sits at (0 = top level). */
type Placed = { level: number; block: BnPartial };

/** A list node → its items, each placed at its nesting level. A SuperDoc row
 *  is one item wrapped in text-less items for depth (extract.ts listNode);
 *  those wrappers only add depth. A TipTap-era row may hold a whole list. */
function listItems(list: PMNode, level: number, firstId: { id?: string }): Placed[] {
  const type = list.type === "orderedList" ? "numberedListItem" : "bulletListItem";
  const out: Placed[] = [];
  for (const item of list.content ?? []) {
    const line = firstLine(item);
    const nested = (item.content ?? []).filter((c) => c.type === "bulletList" || c.type === "orderedList");
    const hasText = (line ?? []).some((n) => n.text || n.type === "hardBreak");
    if (hasText || nested.length === 0) {
      const id = firstId.id;
      firstId.id = undefined; // only the row's first block keeps its id
      out.push({ level, block: { ...(id ? { id } : {}), type, content: pmToInline(line) } });
    }
    // Nested lists sit one level down — under this item, or, for a wrapper
    // with no text of its own, under the item the previous row ended with.
    for (const n of nested) out.push(...listItems(n, level + 1, firstId));
  }
  return out;
}

/** Everything that isn't a list → one block. */
function singleBlock(node: PMNode, id: string): BnPartial {
  switch (node.type) {
    case "heading":
      return {
        id,
        type: "heading",
        props: { level: Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)) },
        content: pmToInline(node.content),
      };
    case "blockquote":
      return { id, type: "quote", content: pmToInline(firstLine(node)) };
    case "codeBlock":
      return { id, type: "codeBlock", content: pmToInline(node.content) };
    case "table":
      return {
        id,
        type: "table",
        content: {
          type: "tableContent",
          rows: (node.content ?? []).map((row) => ({
            cells: (row.content ?? []).map((cell) => pmToInline(firstLine(cell))),
          })),
        },
      };
    case "horizontalRule":
      return { id, type: "divider" };
    default:
      return { id, type: "paragraph", content: pmToInline(firstLine(node) ?? node.content) };
  }
}

/**
 * Block rows (live, in order) → a BlockNote document. Each row's first block
 * keeps the row's id, so attribution and the diff carry straight over. List
 * items are rows of their own; an item one level deeper than the item before
 * it becomes that item's child, which is how BlockNote nests lists.
 */
export function rowsToBlocks(rows: { blockId: string; content: unknown }[]): BnPartial[] {
  const placed: Placed[] = [];
  for (const row of rows) {
    const node = (typeof row.content === "string" ? JSON.parse(row.content) : row.content) as PMNode | null;
    if (!node || typeof node !== "object") continue;
    if (node.type === "bulletList" || node.type === "orderedList") {
      placed.push(...listItems(node, 0, { id: row.blockId }));
    } else {
      placed.push({ level: 0, block: singleBlock(node, row.blockId) });
    }
  }

  const top: BnPartial[] = [];
  // stack[i] = the latest block placed at level i
  const stack: BnPartial[] = [];
  for (const { level, block } of placed) {
    // Never deeper than one past the block before it.
    const at = Math.min(level, stack.length);
    if (at === 0) top.push(block);
    else (stack[at - 1].children ??= []).push(block);
    stack.length = at;
    stack.push(block);
  }
  return top;
}
