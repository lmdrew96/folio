import { download, slugify, standaloneHtml } from "@/lib/export";

/**
 * Export a SuperDoc document. Same formats as the TipTap editor minus RTF
 * (dropped in the migration). SuperDoc exports DOCX natively; Markdown and HTML
 * come from its Document API converters, plain text from its block listing;
 * PDF reuses the print path
 * (globals.css puts just the pages on paper), exactly as the TipTap editor did.
 */

export type SuperDocExportFormat = "pdf" | "docx" | "md" | "html" | "txt";

export const SUPERDOC_EXPORT_FORMATS: { id: SuperDocExportFormat; label: string }[] = [
  { id: "pdf", label: "PDF" },
  { id: "docx", label: "Word" },
  { id: "md", label: "Markdown" },
  { id: "html", label: "HTML" },
  { id: "txt", label: "Plain text" },
];

type MaybePromise<T> = T | Promise<T>;

/** The slices of SuperDoc this needs (the instance and its Document API). */
export type ExportSources = {
  exportDocx(): Promise<Blob>;
  doc: {
    getMarkdown(input: object): MaybePromise<string>;
    getHtml(input: object): MaybePromise<string>;
    blocks: {
      list(input: object): MaybePromise<{ blocks: { text?: string | null; textPreview: string | null }[] }>;
    };
  };
};

export async function exportSuperDoc(
  sources: ExportSources,
  title: string,
  format: SuperDocExportFormat,
): Promise<void> {
  if (format === "pdf") {
    // The browser's print dialog offers "Save as PDF".
    window.print();
    return;
  }
  const base = slugify(title);
  switch (format) {
    case "docx":
      download(
        await sources.exportDocx(),
        `${base}.docx`,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      return;
    case "md":
      download(await sources.doc.getMarkdown({}), `${base}.md`, "text/markdown;charset=utf-8");
      return;
    case "html":
      download(
        standaloneHtml(title, await sources.doc.getHtml({})),
        `${base}.html`,
        "text/html;charset=utf-8",
      );
      return;
    case "txt": {
      // One paragraph per block, blank line between — SuperDoc's getText runs
      // paragraphs together with no separator.
      const { blocks } = await sources.doc.blocks.list({ includeText: true, limit: 20_000 });
      const text = blocks.map((b) => b.text ?? b.textPreview ?? "").join("\n\n");
      download(text, `${base}.txt`, "text/plain;charset=utf-8");
      return;
    }
  }
}
