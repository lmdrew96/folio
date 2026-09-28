import type { Editor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";

export type ExportFormat = "pdf" | "docx" | "md" | "rtf" | "html" | "txt";

export const EXPORT_FORMATS: { id: ExportFormat; label: string; ext: string }[] =
  [
    { id: "pdf", label: "PDF", ext: "pdf" },
    { id: "docx", label: "Word", ext: "docx" },
    { id: "md", label: "Markdown", ext: "md" },
    { id: "rtf", label: "Rich Text", ext: "rtf" },
    { id: "html", label: "HTML", ext: "html" },
    { id: "txt", label: "Plain text", ext: "txt" },
  ];

type Node = JSONContent;
type Mark = NonNullable<JSONContent["marks"]>[number];

const hasMark = (marks: Mark[] | undefined, type: string) =>
  marks?.some((m) => m.type === type) ?? false;

const linkHref = (marks: Mark[] | undefined): string | undefined => {
  const href = marks?.find((m) => m.type === "link")?.attrs?.href;
  return typeof href === "string" ? href : undefined;
};

/** A footnote's visible number. In the editor it only exists as CSS
 *  (`content: attr(data-n)`), so every format has to write it out itself or
 *  the notes export as unnumbered paragraphs. */
const footnoteLabel = (node: Node): string =>
  typeof node.attrs?.n === "number" && node.attrs.n > 0 ? `${node.attrs.n}. ` : "";

type TableCellNode = { node: Node; header: boolean; colspan: number; rowspan: number };

/** A table's rows → cells, with header-ness and spans read off the JSON. */
function tableRows(table: Node): TableCellNode[][] {
  return (table.content ?? []).map((row) =>
    (row.content ?? []).map((cell) => ({
      node: cell,
      header: cell.type === "tableHeader",
      colspan: typeof cell.attrs?.colspan === "number" ? cell.attrs.colspan : 1,
      rowspan: typeof cell.attrs?.rowspan === "number" ? cell.attrs.rowspan : 1,
    })),
  );
}

/** All descendant text, with code-block newlines preserved. */
function textOf(node: Node): string {
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map(textOf).join("");
}

// ── filename + download ──────────────────────────────────────────────────────

function slugify(title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "document";
}

function download(data: Blob | string, filename: string, mime: string): void {
  const blob = typeof data === "string" ? new Blob([data], { type: mime }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Markdown ─────────────────────────────────────────────────────────────────

// Escape only the characters that would trigger inline markdown, so exported
// prose stays readable rather than littered with backslashes.
const mdEscape = (t: string) => t.replace(/[\\`*_[\]]/g, (c) => "\\" + c);

function mdInline(nodes: Node[] | undefined): string {
  if (!nodes) return "";
  let out = "";
  for (const n of nodes) {
    if (n.type === "hardBreak") {
      out += "  \n";
      continue;
    }
    if (n.type === "footnoteRef") {
      out += `[${typeof n.attrs?.n === "number" ? n.attrs.n : ""}]`;
      continue;
    }
    if (n.type !== "text" || typeof n.text !== "string") continue;
    const href = linkHref(n.marks);
    if (hasMark(n.marks, "code")) {
      // Code spans are literal — no nested emphasis.
      let t = "`" + n.text + "`";
      if (href) t = `[${t}](${href})`;
      out += t;
      continue;
    }
    let t = mdEscape(n.text);
    if (hasMark(n.marks, "bold")) t = `**${t}**`;
    if (hasMark(n.marks, "italic")) t = `*${t}*`;
    if (hasMark(n.marks, "strike")) t = `~~${t}~~`;
    if (hasMark(n.marks, "highlight")) t = `==${t}==`;
    if (hasMark(n.marks, "underline")) t = `<u>${t}</u>`;
    if (href) t = `[${t}](${href})`;
    out += t;
  }
  return out;
}

/** A list item's own text line(s) — paragraphs, plus headings now that a
 *  bullet can be promoted to one (see DocEditor's ListItem content override).
 *  Without heading here, a heading'd list line exported as an empty bullet. */
function isItemLine(child: Node): boolean {
  return child.type === "paragraph" || child.type === "heading";
}

function mdList(list: Node, depth: number): string {
  const ordered = list.type === "orderedList";
  const start = typeof list.attrs?.start === "number" ? list.attrs.start : 1;
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  (list.content ?? []).forEach((item, i) => {
    const marker = ordered ? `${start + i}. ` : "- ";
    let firstText = "";
    const rest: string[] = [];
    for (const child of item.content ?? []) {
      if (isItemLine(child) && firstText === "") {
        firstText = mdInline(child.content);
      } else if (child.type === "bulletList" || child.type === "orderedList") {
        rest.push(mdList(child, depth + 1));
      } else if (child.type === "paragraph") {
        rest.push(indent + "  " + mdInline(child.content));
      } else {
        rest.push(...mdBlocks([child], depth + 1));
      }
    }
    lines.push(indent + marker + firstText);
    if (rest.length) lines.push(rest.join("\n"));
  });
  return lines.join("\n");
}

function mdBlocks(nodes: Node[] | undefined, depth = 0): string[] {
  if (!nodes) return [];
  const out: string[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
        out.push(mdInline(node.content));
        break;
      case "heading": {
        const lvl =
          typeof node.attrs?.level === "number" ? node.attrs.level : 1;
        out.push("#".repeat(lvl) + " " + mdInline(node.content));
        break;
      }
      case "blockquote": {
        const inner = mdBlocks(node.content).join("\n\n");
        out.push(
          inner
            .split("\n")
            .map((l) => (l ? "> " + l : ">"))
            .join("\n"),
        );
        break;
      }
      case "codeBlock": {
        const lang =
          typeof node.attrs?.language === "string" ? node.attrs.language : "";
        out.push("```" + lang + "\n" + textOf(node) + "\n```");
        break;
      }
      case "bulletList":
      case "orderedList":
        out.push(mdList(node, depth));
        break;
      case "horizontalRule":
        out.push("---");
        break;
      case "table":
        out.push(mdTable(node));
        break;
      case "footnote":
        // "[1] …", not "1. …" — a leading "1. " would parse as an ordered list.
        out.push(
          (footnoteLabel(node) ? `[${node.attrs?.n}] ` : "") +
            mdInline(node.content),
        );
        break;
      default:
        if (node.content) out.push(mdInline(node.content));
    }
  }
  return out;
}

/** GFM pipe table. GFM has no headerless tables and no cell spans, so the
 *  first row always becomes the header and a spanned cell pads its row with
 *  empty cells to keep the columns lined up. Multi-block cells join with <br>. */
function mdTable(table: Node): string {
  const rows = tableRows(table).map((cells) =>
    cells.flatMap((c) => [
      mdBlocks(c.node.content)
        .join("<br>")
        .replace(/\n/g, "<br>")
        .replace(/\|/g, "\\|"),
      ...Array<string>(c.colspan - 1).fill(""),
    ]),
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) =>
    "| " + [...cells, ...Array<string>(width - cells.length).fill("")].join(" | ") + " |";
  return [line(rows[0]), line(Array<string>(width).fill("---")), ...rows.slice(1).map(line)].join(
    "\n",
  );
}

const toMarkdown = (doc: Node) =>
  mdBlocks(doc.content).join("\n\n").trim() + "\n";

// ── Rich Text Format (.rtf) ──────────────────────────────────────────────────

function rtfEscape(t: string): string {
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    const code = t.charCodeAt(i);
    if (ch === "\\") out += "\\\\";
    else if (ch === "{") out += "\\{";
    else if (ch === "}") out += "\\}";
    else if (ch === "\n") out += "\\line ";
    else if (code > 127) out += `\\u${code > 32767 ? code - 65536 : code}?`;
    else out += ch;
  }
  return out;
}

function rtfInline(nodes: Node[] | undefined): string {
  if (!nodes) return "";
  let out = "";
  for (const n of nodes) {
    if (n.type === "hardBreak") {
      out += "\\line ";
      continue;
    }
    if (n.type === "footnoteRef") {
      out += `[${typeof n.attrs?.n === "number" ? n.attrs.n : ""}]`;
      continue;
    }
    if (n.type !== "text" || typeof n.text !== "string") continue;
    let pre = "";
    let post = "";
    if (hasMark(n.marks, "code")) {
      pre += "{\\f1 ";
      post = "}" + post;
    }
    if (hasMark(n.marks, "bold")) {
      pre += "\\b ";
      post = "\\b0 " + post;
    }
    if (hasMark(n.marks, "italic")) {
      pre += "\\i ";
      post = "\\i0 " + post;
    }
    if (hasMark(n.marks, "underline")) {
      pre += "\\ul ";
      post = "\\ulnone " + post;
    }
    if (hasMark(n.marks, "strike")) {
      pre += "\\strike ";
      post = "\\strike0 " + post;
    }
    let run = pre + rtfEscape(n.text) + post;
    const href = linkHref(n.marks);
    if (href) {
      run = `{\\field{\\*\\fldinst{HYPERLINK "${rtfEscape(href)}"}}{\\fldrslt ${run}}}`;
    }
    out += run;
  }
  return out;
}

function rtfList(list: Node): string {
  const ordered = list.type === "orderedList";
  const start = typeof list.attrs?.start === "number" ? list.attrs.start : 1;
  let out = "";
  (list.content ?? []).forEach((item, i) => {
    const marker = ordered ? `${start + i}.` : "\\bullet";
    const text = (item.content ?? [])
      .filter(isItemLine)
      .map((p) => rtfInline(p.content))
      .join(" ");
    out += `\\pard\\fi-360\\li720\\sa120 ${marker}\\tab ` + text + "\\par\n";
    for (const nested of item.content ?? []) {
      if (nested.type === "bulletList" || nested.type === "orderedList") {
        out += rtfList(nested);
      }
    }
  });
  return out;
}

function rtfBlocks(nodes: Node[] | undefined): string {
  if (!nodes) return "";
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
        out += "\\pard\\sa180 " + rtfInline(node.content) + "\\par\n";
        break;
      case "heading": {
        const lvl =
          typeof node.attrs?.level === "number" ? node.attrs.level : 1;
        const fs = lvl === 1 ? 36 : lvl === 2 ? 30 : 26;
        out +=
          `\\pard\\sb120\\sa180\\fs${fs}\\b ` +
          rtfInline(node.content) +
          "\\b0\\fs24\\par\n";
        break;
      }
      case "blockquote":
        for (const inner of node.content ?? []) {
          out +=
            "\\pard\\li720\\sa180 " + rtfInline(inner.content) + "\\par\n";
        }
        break;
      case "codeBlock":
        out += "\\pard\\li360\\sa120\\f1 " + rtfEscape(textOf(node)) + "\\par\n\\f0 ";
        break;
      case "bulletList":
      case "orderedList":
        out += rtfList(node);
        break;
      case "horizontalRule":
        out += "\\pard\\brdrb\\brdrs\\brdrw10\\brsp20\\par\\pard\\par\n";
        break;
      case "table":
        out += rtfTable(node);
        break;
      case "footnote":
        out +=
          "\\pard\\sa120\\fs20 " +
          rtfEscape(footnoteLabel(node)) +
          rtfInline(node.content) +
          "\\fs24\\par\n";
        break;
      default:
        if (node.content)
          out += "\\pard\\sa180 " + rtfInline(node.content) + "\\par\n";
    }
  }
  return out;
}

/** RTF table rows: each row declares its cell right-edges (\\cellx, in twips
 *  across a 6.5in text block), then its cells. A colspan widens that cell's
 *  edge; rowspan has no simple RTF equivalent, so a spanned cell just holds
 *  its content in the first row. */
function rtfTable(table: Node): string {
  const rows = tableRows(table);
  const cols = Math.max(1, ...rows.map((r) => r.reduce((n, c) => n + c.colspan, 0)));
  const unit = Math.floor(9360 / cols);
  let out = "";
  for (const cells of rows) {
    out += "\\trowd\\trgaph108";
    let edge = 0;
    for (const c of cells) {
      edge += unit * c.colspan;
      out += `\\clbrdrt\\brdrs\\clbrdrl\\brdrs\\clbrdrb\\brdrs\\clbrdrr\\brdrs\\cellx${edge}`;
    }
    out += "\n";
    for (const c of cells) {
      const text = (c.node.content ?? []).map((b) => rtfInline(b.content)).join("\\line ");
      out += "\\pard\\intbl " + (c.header ? `\\b ${text}\\b0 ` : text) + "\\cell\n";
    }
    out += "\\row\n";
  }
  return out + "\\pard\\par\n";
}

const toRtf = (doc: Node) =>
  "{\\rtf1\\ansi\\ansicpg1252\\deff0\\fs24" +
  "{\\fonttbl{\\f0\\froman Georgia;}{\\f1\\fmodern Consolas;}}\n" +
  rtfBlocks(doc.content) +
  "}";

// ── HTML ─────────────────────────────────────────────────────────────────────

const htmlEscape = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );

/** The editor's HTML, minus editor-only plumbing: block ids (UniqueID's
 *  data-id) and footnote cross-reference ids are internal bookkeeping, and
 *  footnote numbers exist only as CSS in the app — write them in as text so
 *  the references and notes aren't blank in the exported file. */
function cleanEditorHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  doc.querySelectorAll("sup.folio-footnote-ref").forEach((el) => {
    el.textContent = el.getAttribute("data-n") ?? "";
  });
  doc.querySelectorAll("p.folio-footnote").forEach((el, i) => {
    if (i === 0) el.classList.add("first");
    const n = el.getAttribute("data-n");
    if (n && n !== "0") el.prepend(`${n}. `);
  });
  doc
    .querySelectorAll("[data-id], [data-ref-id], [data-footnote-id], [data-n]")
    .forEach((el) => {
      for (const attr of ["data-id", "data-ref-id", "data-footnote-id", "data-n"]) {
        el.removeAttribute(attr);
      }
    });
  return doc.body.innerHTML;
}

const toHtml = (editor: Editor, title: string) =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(title)}</title>
<style>
  body { font-family: Georgia, "Times New Roman", serif; line-height: 1.6;
         max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; color: #1a1a1a; }
  h1, h2, h3, h4 { line-height: 1.25; }
  blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 1rem; color: #444; }
  pre { background: #f5f5f5; padding: .75rem 1rem; border-radius: 6px; overflow: auto; }
  code { font-family: Consolas, ui-monospace, monospace; }
  mark { padding: 0 .15em; border-radius: 2px; background: #ffd7c3; color: #20161e; }
  mark[data-highlight="green"] { background: #c6c3ba; }
  mark[data-highlight="mint"] { background: #c6c6cb; }
  mark[data-highlight="lavender"] { background: #cdc1c8; }
  table { border-collapse: collapse; width: 100%; margin: 1.25rem 0; }
  th, td { border: 1px solid #ccc; padding: .35rem .6rem; vertical-align: top; text-align: left; }
  th { background: #f3f3f3; }
  th > p, td > p { margin: 0; }
  .folio-footnote { font-size: .85em; color: #444; }
  .folio-footnote.first { margin-top: 2rem; padding-top: .75rem; border-top: 1px solid #ccc; }
  a { color: inherit; }
</style>
</head>
<body>
${cleanEditorHtml(editor.getHTML())}
</body>
</html>
`;

// ── Word (.docx) — docx is dynamically imported so it never enters the main bundle ─

async function toDocxBlob(doc: Node, title: string): Promise<Blob> {
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    AlignmentType,
    BorderStyle,
    ExternalHyperlink,
    Table,
    TableRow,
    TableCell,
    WidthType,
  } = await import("docx");

  type Run = InstanceType<typeof TextRun> | InstanceType<typeof ExternalHyperlink>;

  const alignOf = (a: unknown) =>
    a === "center"
      ? AlignmentType.CENTER
      : a === "right"
        ? AlignmentType.RIGHT
        : a === "justify"
          ? AlignmentType.JUSTIFIED
          : undefined;

  const runs = (nodes: Node[] | undefined): Run[] => {
    if (!nodes) return [];
    const out: Run[] = [];
    for (const n of nodes) {
      if (n.type === "hardBreak") {
        out.push(new TextRun({ break: 1 }));
        continue;
      }
      if (n.type === "footnoteRef") {
        const num = typeof n.attrs?.n === "number" ? n.attrs.n : "";
        out.push(new TextRun({ text: String(num), superScript: true }));
        continue;
      }
      if (n.type !== "text" || typeof n.text !== "string") continue;
      const opts = {
        text: n.text,
        bold: hasMark(n.marks, "bold"),
        italics: hasMark(n.marks, "italic"),
        strike: hasMark(n.marks, "strike"),
        underline: hasMark(n.marks, "underline") ? {} : undefined,
        font: hasMark(n.marks, "code") ? "Consolas" : undefined,
      };
      const href = linkHref(n.marks);
      if (href) {
        out.push(
          new ExternalHyperlink({
            link: href,
            children: [new TextRun({ ...opts, style: "Hyperlink" })],
          }),
        );
      } else {
        out.push(new TextRun(opts));
      }
    }
    return out;
  };

  type Para = InstanceType<typeof Paragraph>;

  const listToParas = (list: Node, level: number): Para[] => {
    const ordered = list.type === "orderedList";
    const start = typeof list.attrs?.start === "number" ? list.attrs.start : 1;
    const out: Para[] = [];
    (list.content ?? []).forEach((item, i) => {
      const itemRuns = (item.content ?? [])
        .filter(isItemLine)
        .flatMap((p) => runs(p.content));
      if (ordered) {
        out.push(
          new Paragraph({
            children: [new TextRun({ text: `${start + i}. ` }), ...itemRuns],
            indent: { left: 720 * (level + 1), hanging: 360 },
          }),
        );
      } else {
        out.push(new Paragraph({ children: itemRuns, bullet: { level } }));
      }
      for (const nested of item.content ?? []) {
        if (nested.type === "bulletList" || nested.type === "orderedList") {
          out.push(...listToParas(nested, level + 1));
        }
      }
    });
    return out;
  };

  type Block = Para | InstanceType<typeof Table>;

  // Header cells: bold every run, the way the app renders <th>.
  const boldify = (n: Node): Node =>
    n.type === "text"
      ? { ...n, marks: [...(n.marks ?? []), { type: "bold" }] }
      : n.content
        ? { ...n, content: n.content.map(boldify) }
        : n;

  const tableToDocx = (table: Node): InstanceType<typeof Table> =>
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: tableRows(table).map(
        (cells) =>
          new TableRow({
            tableHeader: cells.length > 0 && cells.every((c) => c.header),
            children: cells.map(
              (c) =>
                new TableCell({
                  columnSpan: c.colspan > 1 ? c.colspan : undefined,
                  rowSpan: c.rowspan > 1 ? c.rowspan : undefined,
                  // A cell must hold at least one paragraph, even when empty.
                  children: (() => {
                    const blocks = (c.node.content ?? [])
                      .map((b) => (c.header ? boldify(b) : b))
                      .flatMap(blockToParas);
                    return blocks.length ? blocks : [new Paragraph({ children: [] })];
                  })(),
                }),
            ),
          }),
      ),
    });

  const blockToParas = (node: Node): Block[] => {
    switch (node.type) {
      case "paragraph":
        return [
          new Paragraph({
            children: runs(node.content),
            alignment: alignOf(node.attrs?.textAlign),
          }),
        ];
      case "heading": {
        const lvl =
          typeof node.attrs?.level === "number" ? node.attrs.level : 1;
        const heading =
          lvl === 1
            ? HeadingLevel.HEADING_1
            : lvl === 2
              ? HeadingLevel.HEADING_2
              : HeadingLevel.HEADING_3;
        return [
          new Paragraph({
            heading,
            children: runs(node.content),
            alignment: alignOf(node.attrs?.textAlign),
          }),
        ];
      }
      case "blockquote":
        return (node.content ?? []).map(
          (inner) =>
            new Paragraph({
              children: runs(inner.content),
              indent: { left: 720 },
              border: {
                left: {
                  color: "CCCCCC",
                  space: 12,
                  style: BorderStyle.SINGLE,
                  size: 12,
                },
              },
            }),
        );
      case "codeBlock":
        return textOf(node)
          .split("\n")
          .map(
            (line) =>
              new Paragraph({
                children: [
                  new TextRun({ text: line, font: "Consolas", size: 20 }),
                ],
                indent: { left: 360 },
              }),
          );
      case "bulletList":
      case "orderedList":
        return listToParas(node, 0);
      case "horizontalRule":
        return [
          new Paragraph({
            children: [],
            border: {
              bottom: {
                color: "CCCCCC",
                space: 1,
                style: BorderStyle.SINGLE,
                size: 6,
              },
            },
          }),
        ];
      case "table":
        return [tableToDocx(node)];
      case "footnote":
        return [
          new Paragraph({
            children: [
              new TextRun({ text: footnoteLabel(node), size: 20 }),
              ...runs(node.content),
            ],
          }),
        ];
      default:
        return node.content ? [new Paragraph({ children: runs(node.content) })] : [];
    }
  };

  const body = (doc.content ?? []).flatMap(blockToParas);
  const document = new Document({
    title,
    sections: [{ children: body }],
  });
  return Packer.toBlob(document);
}

// ── dispatch ─────────────────────────────────────────────────────────────────

export async function exportDocument(
  editor: Editor,
  title: string,
  format: ExportFormat,
): Promise<void> {
  if (format === "pdf") {
    // Reuse the print pipeline (globals.css @media print puts just the sheet on
    // the page); the browser's print dialog offers "Save as PDF".
    window.print();
    return;
  }

  const base = slugify(title);
  const json = editor.getJSON();

  switch (format) {
    case "txt":
      download(
        editor.getText({
          blockSeparator: "\n\n",
          textSerializers: {
            footnote: ({ node }) =>
              footnoteLabel(node.toJSON() as Node) + node.textContent,
            // One line per row, cells separated by tabs — pastes cleanly into
            // a spreadsheet, and doesn't blow each cell into its own paragraph.
            table: ({ node }) => {
              const lines: string[] = [];
              node.forEach((row) => {
                const cells: string[] = [];
                row.forEach((cell) =>
                  cells.push(cell.textBetween(0, cell.content.size, " ", " ").trim()),
                );
                lines.push(cells.join("\t"));
              });
              return lines.join("\n");
            },
          },
        }),
        `${base}.txt`,
        "text/plain;charset=utf-8",
      );
      return;
    case "html":
      download(toHtml(editor, title), `${base}.html`, "text/html;charset=utf-8");
      return;
    case "md":
      download(toMarkdown(json), `${base}.md`, "text/markdown;charset=utf-8");
      return;
    case "rtf":
      download(toRtf(json), `${base}.rtf`, "application/rtf");
      return;
    case "docx": {
      const blob = await toDocxBlob(json, title);
      download(
        blob,
        `${base}.docx`,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      return;
    }
  }
}
