/**
 * A block row's ProseMirror JSON → plain text or markdown. Shared by the MCP
 * door (convex/mcpData.ts) and the changes panel (convex/diff.ts), which
 * both read the same TipTap-shaped JSON — SuperDoc documents included, via
 * the derived rows src/superdoc/extract.ts writes.
 */

/** `underline: false` drops underline instead of writing `<u>…</u>` — for
 *  renderers that escape raw HTML (the app's Markdown component), where the
 *  tags would show as text. Markdown has no underline syntax of its own. */
export type MarkdownOptions = { underline?: boolean };

const SEPARATED = new Set(["tableCell", "tableHeader", "paragraph", "heading", "listItem"]);

/** Plain text of a ProseMirror block's JSON.
 *  Flattens everything with no structural separator — fine as a last-resort
 *  fallback for unrecognized node types, but NOT for list content (see
 *  blockMarkdown below, which is what read/preview paths actually use). */
export function blockText(content: unknown): string {
  const parts: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const node = n as { type?: unknown; text?: unknown; content?: unknown };
    if (typeof node.text === "string") parts.push(node.text);
    if (Array.isArray(node.content)) for (const c of node.content) walk(c);
    // Cells, items and lines are separate words, not one run: "Name" + "Age" ≠ "NameAge".
    if (typeof node.type === "string" && SEPARATED.has(node.type)) parts.push(" ");
  };
  walk(content);
  return parts.join("").replace(/\s+/g, " ").trim();
}

/** Minimal shape of a ProseMirror/TipTap JSON node, as stored in a block row's
 *  `content` field (see convex/schema.ts — one top-level editor node per row). */
type PMNode = {
  type?: string;
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
  content?: PMNode[];
};

const hasMark = (marks: PMNode["marks"], type: string) =>
  marks?.some((m) => m.type === type) ?? false;

/** Inline run (a paragraph/heading's `content`) → markdown text, applying
 *  bold/italic/strike/underline/code/link marks. Concatenated directly —
 *  these are genuinely adjacent text runs within one line, not separate
 *  items. Link href wraps around the already-formatted text (Tiptap's Link
 *  mark, attrs.href — see @tiptap/extension-link), matching the
 *  `[**text**](href)` convention so the URL survives the round trip to the
 *  MCP client instead of vanishing. `code` short-circuits the rest: Tiptap's
 *  Code mark sets `excludes: '_'`, so a code run never carries any other
 *  mark — backticks would otherwise collide with `**`/`~~`/`<u>` wrapping. */
function mdInline(nodes: PMNode[] | undefined, opts: MarkdownOptions): string {
  if (!nodes) return "";
  let out = "";
  for (const n of nodes) {
    if (typeof n.text !== "string") continue;
    if (hasMark(n.marks, "code")) {
      out += `\`${n.text}\``;
      continue;
    }
    let t = n.text;
    if (hasMark(n.marks, "bold")) t = `**${t}**`;
    if (hasMark(n.marks, "italic")) t = `*${t}*`;
    if (hasMark(n.marks, "strike")) t = `~~${t}~~`;
    if (opts.underline !== false && hasMark(n.marks, "underline")) t = `<u>${t}</u>`;
    const href = n.marks?.find((m) => m.type === "link")?.attrs?.href;
    if (typeof href === "string" && href) t = `[${t}](${href})`;
    out += t;
  }
  return out;
}

/** bulletList/orderedList → one markdown line per item (nested lists indented).
 *  This is the fix for Bug 1: list items are discrete child nodes in storage
 *  already — the old `blockText` walk just joined them with "". Here each
 *  item becomes its own line, so boundaries survive. */
function mdList(list: PMNode, opts: MarkdownOptions, depth = 0): string {
  const ordered = list.type === "orderedList";
  const start =
    typeof list.attrs?.start === "number" ? (list.attrs.start as number) : 1;
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  (list.content ?? []).forEach((item, i) => {
    const marker = ordered ? `${start + i}. ` : "- ";
    const nested: string[] = [];
    let firstLine = "";
    for (const child of item.content ?? []) {
      if (child.type === "bulletList" || child.type === "orderedList") {
        nested.push(mdList(child, opts, depth + 1));
      } else if (firstLine === "") {
        firstLine = mdInline(child.content, opts);
      }
    }
    // A SuperDoc-derived block is ONE item, its depth rebuilt as wrapper
    // items with no text of their own (src/superdoc/extract.ts listNode) —
    // those wrappers carry nesting only, so they get no empty "- " line.
    if (firstLine !== "" || nested.length === 0) lines.push(indent + marker + firstLine);
    if (nested.length) lines.push(...nested);
  });
  return lines.join("\n");
}

/** table → GFM pipe table (first row as header — GFM has no headerless
 *  form). A cell's blocks join with <br> so each row stays on one line. */
function mdTable(table: PMNode, opts: MarkdownOptions): string {
  const rows = (table.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      (cell.content ?? [])
        .map((b) => mdInline(b.content, opts) || blockText(b))
        .join("<br>")
        .replace(/\|/g, "\\|"),
    ),
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) =>
    "| " + [...cells, ...Array<string>(width - cells.length).fill("")].join(" | ") + " |";
  return [line(rows[0]), line(Array<string>(width).fill("---")), ...rows.slice(1).map(line)].join(
    "\n",
  );
}

/**
 * Serialize one top-level block's ProseMirror JSON to markdown — the
 * Claude-facing fix for Bug 2 (formatting never reached Claude) that also
 * fixes Bug 1 for free (list items are rendered one per line instead of
 * flattened). Covers the confirmed block types (paragraph, heading,
 * bulletList, orderedList) plus bold/italic marks; anything else falls back
 * to the flattened `blockText` so an unrecognized node still reads as text
 * rather than throwing.
 */
export function blockMarkdown(content: unknown, opts: MarkdownOptions = {}): string {
  const node = content as PMNode | null;
  if (!node || typeof node !== "object") return "";
  switch (node.type) {
    case "heading": {
      const level =
        typeof node.attrs?.level === "number" ? (node.attrs.level as number) : 1;
      return "#".repeat(level) + " " + mdInline(node.content, opts);
    }
    case "bulletList":
    case "orderedList":
      return mdList(node, opts);
    case "paragraph":
      return mdInline(node.content, opts);
    case "table":
      return mdTable(node, opts);
    default:
      return mdInline(node.content, opts) || blockText(content);
  }
}

