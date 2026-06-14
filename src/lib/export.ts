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
      if (child.type === "paragraph" && firstText === "") {
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
      default:
        if (node.content) out.push(mdInline(node.content));
    }
  }
  return out;
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
      .filter((c) => c.type === "paragraph")
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
      default:
        if (node.content)
          out += "\\pard\\sa180 " + rtfInline(node.content) + "\\par\n";
    }
  }
  return out;
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
  h1, h2, h3 { line-height: 1.25; }
  blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 1rem; color: #444; }
  pre { background: #f5f5f5; padding: .75rem 1rem; border-radius: 6px; overflow: auto; }
  code { font-family: Consolas, ui-monospace, monospace; }
  mark { padding: 0 .15em; border-radius: 2px; }
  a { color: inherit; }
</style>
</head>
<body>
${editor.getHTML()}
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
        .filter((c) => c.type === "paragraph")
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

  const blockToParas = (node: Node): Para[] => {
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
        editor.getText({ blockSeparator: "\n\n" }),
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
