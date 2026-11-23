"use client";

import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { folioSchema } from "@/blocknote/schema";
import { useRovingToolbar } from "@/lib/useRovingToolbar";
import { useKeepInViewport } from "@/lib/useKeepInViewport";
import { EXPORT_FORMATS, type ExportFormat } from "@/lib/export";
import { InputPopover } from "./InputPopover";

type FolioEditor = typeof folioSchema.BlockNoteEditor;
type FolioBlock = typeof folioSchema.Block;

/** The highlight the toolbar applies: BlockNote's "orange" background, which
 *  globals.css paints as Squid Ink's coral wash. */
const HIGHLIGHT = "orange";
/** Average adult silent-reading speed, for the "min read" estimate. */
const WORDS_PER_MINUTE = 238;

const STYLE_OPTIONS = [
  { value: "paragraph", label: "Paragraph" },
  { value: "h1", label: "Heading 1" },
  { value: "h2", label: "Heading 2" },
  { value: "h3", label: "Heading 3" },
] as const;
type StyleValue = (typeof STYLE_OPTIONS)[number]["value"] | "other";

export type OutlineHeading = { nodeId: string; level: number; text: string };

export const countWords = (text: string): number => {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
};

const parseWordGoal = (input: string) => Math.round(Number(input.replace(/[,\s_]/g, "")));

const BUTTON =
  "inline-flex min-h-9 min-w-9 items-center justify-center rounded-md px-2 text-sm text-foreground transition hover:bg-chip aria-pressed:bg-chip disabled:opacity-50";

/** Blocks the next command applies to: the selection, or the cursor's block. */
function targetBlocks(editor: FolioEditor): FolioBlock[] {
  return editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
}

/** What the toolbar reflects, read fresh from the editor on every change. */
function readState(editor: FolioEditor) {
  try {
    const styles = editor.getActiveStyles();
    const block = editor.getTextCursorPosition().block;
    const level = block.type === "heading" ? Number(block.props.level) : 0;
    const style: StyleValue =
      block.type === "paragraph"
        ? "paragraph"
        : level >= 1 && level <= 3
          ? (`h${level}` as StyleValue)
          : "other";
    return {
      bold: Boolean(styles.bold),
      italic: Boolean(styles.italic),
      underline: Boolean(styles.underline),
      strike: Boolean(styles.strike),
      highlight: styles.backgroundColor === HIGHLIGHT,
      link: Boolean(editor.getSelectedLinkUrl()),
      blockType: block.type as string,
      style,
    };
  } catch {
    // Before the view mounts there's no selection to read.
    return null;
  }
}

/**
 * Folio's always-visible formatting row for BlockNote documents: undo/redo,
 * paragraph style, B I U S, highlight, link, lists and quote on the left; the
 * outline toggle, word readout (which also holds the word goal) and a ⋯ menu
 * with Export on the right. Buttons act on the editor's selection, so they
 * keep focus in the page (mousedown is prevented) and hand it back after.
 */
export function EditorToolbar({
  editor,
  documentId,
  editable,
  wordCount,
  selectedWordCount,
  outlineOpen,
  onToggleOutline,
  onExport,
}: {
  editor: FolioEditor;
  documentId: Id<"documents">;
  editable: boolean;
  wordCount: number;
  selectedWordCount: number;
  outlineOpen: boolean;
  onToggleOutline: () => void;
  onExport: (format: ExportFormat) => Promise<void>;
}) {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const offChange = editor.onChange(refresh);
    const offSelection = editor.onSelectionChange(refresh);
    return () => {
      offChange();
      offSelection();
    };
  }, [editor]);

  const toolbarRef = useRef<HTMLDivElement>(null);
  const roving = useRovingToolbar(toolbarRef);
  const state = readState(editor);
  const disabled = !editable || state === null;

  const run = (fn: () => void) => () => {
    fn();
    editor.focus();
  };
  const toggleBlockType = (type: "bulletListItem" | "numberedListItem" | "quote") =>
    run(() => {
      const blocks = targetBlocks(editor);
      const off = blocks.every((b) => b.type === type);
      // One transaction, so one click is one undo step.
      editor.transact(() => {
        for (const b of blocks) editor.updateBlock(b, { type: off ? "paragraph" : type });
      });
    });
  const setStyle = (value: StyleValue) => {
    if (value === "other") return;
    const blocks = targetBlocks(editor);
    editor.transact(() => {
      for (const b of blocks) {
        editor.updateBlock(
          b,
          value === "paragraph" ? { type: "paragraph" } : { type: "heading", props: { level: Number(value[1]) as 1 | 2 | 3 } },
        );
      }
    });
    editor.focus();
  };

  // Keeps the page's selection while a button is clicked.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();
  const button = (label: string, content: ReactNode, onClick: () => void, pressed?: boolean, extra = "") => (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onMouseDown={keepFocus}
      onClick={onClick}
      className={`${BUTTON} ${extra}`}
    >
      {content}
    </button>
  );
  const divider = <span aria-hidden="true" className="mx-1.5 h-5 w-px bg-line" />;

  return (
    // role="toolbar" is only honest alongside useRovingToolbar (one tab stop,
    // arrow keys within).
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="Formatting"
      aria-orientation="horizontal"
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
      className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-bar px-3 py-1.5 sm:px-6 print:hidden"
    >
      {button("Undo", <span aria-hidden="true">↶</span>, run(() => editor.undo()))}
      {button("Redo", <span aria-hidden="true">↷</span>, run(() => editor.redo()))}
      {divider}
      <label className="sr-only" htmlFor="folio-bn-style">
        Paragraph style
      </label>
      <select
        id="folio-bn-style"
        value={state?.style ?? "paragraph"}
        disabled={disabled}
        onChange={(e) => setStyle(e.target.value as StyleValue)}
        className="min-h-9 rounded-md border border-line bg-transparent px-2 text-sm text-foreground disabled:opacity-50 [&>option]:bg-page"
      >
        {STYLE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {state?.style === "other" && (
          <option value="other" disabled>
            {state.blockType === "heading" ? "Heading" : "Other"}
          </option>
        )}
      </select>
      {divider}
      {button("Bold", <span aria-hidden="true" className="font-bold">B</span>, run(() => editor.toggleStyles({ bold: true })), state?.bold ?? false)}
      {button("Italic", <span aria-hidden="true" className="italic">I</span>, run(() => editor.toggleStyles({ italic: true })), state?.italic ?? false)}
      {button("Underline", <span aria-hidden="true" className="underline">U</span>, run(() => editor.toggleStyles({ underline: true })), state?.underline ?? false)}
      {button("Strikethrough", <span aria-hidden="true" className="line-through">S</span>, run(() => editor.toggleStyles({ strike: true })), state?.strike ?? false)}
      {button(
        "Highlight",
        <span aria-hidden="true" className="rounded-sm bg-highlight px-1">ab</span>,
        run(() => editor.toggleStyles({ backgroundColor: HIGHLIGHT })),
        state?.highlight ?? false,
      )}
      <InputPopover
        label={state?.link ? "Edit link" : "Link"}
        trigger={<span className="text-ink-blue">Link</span>}
        triggerClassName={BUTTON}
        active={state?.link ?? false}
        fieldLabel="Link address"
        placeholder="https://…"
        inputMode="url"
        initialValue={() => editor.getSelectedLinkUrl() ?? ""}
        validate={(v) => (/^\s*\S+\s*$/.test(v) ? null : "A link can't contain spaces.")}
        onApply={(v) => {
          const url = v.trim();
          // With nothing selected, the address becomes the link's text.
          editor.createLink(url, editor.getSelectedText() ? undefined : url);
          editor.focus();
        }}
        onClear={() => editor.focus()}
        clearLabel="Cancel"
        canClear={false}
        refocusTrigger={false}
      />
      {divider}
      {button("Bulleted list", <span aria-hidden="true">• List</span>, toggleBlockType("bulletListItem"), state?.blockType === "bulletListItem")}
      {button("Numbered list", <span aria-hidden="true">1. List</span>, toggleBlockType("numberedListItem"), state?.blockType === "numberedListItem")}
      {button("Quote", <span aria-hidden="true">❝ Quote</span>, toggleBlockType("quote"), state?.blockType === "quote")}

      <div className="ml-auto flex flex-wrap items-center gap-1">
        <button
          type="button"
          aria-pressed={outlineOpen}
          onClick={onToggleOutline}
          className={`${BUTTON} border border-line px-3`}
        >
          Outline
        </button>
        <WordReadout documentId={documentId} wordCount={wordCount} selectedWordCount={selectedWordCount} />
        <ExportMenu onExport={onExport} />
      </div>
    </div>
  );
}

/** "N words · N min read"; opens the word goal. */
function WordReadout({
  documentId,
  wordCount,
  selectedWordCount,
}: {
  documentId: Id<"documents">;
  wordCount: number;
  selectedWordCount: number;
}) {
  const doc = useQuery(api.documents.get, { documentId });
  const setWordGoal = useMutation(api.documents.setWordGoal);
  const minutes = Math.max(1, Math.ceil(wordCount / WORDS_PER_MINUTE));
  const words =
    selectedWordCount > 0
      ? `${selectedWordCount.toLocaleString()} / ${wordCount.toLocaleString()} words`
      : doc?.wordGoal
        ? `${wordCount.toLocaleString()} / ${doc.wordGoal.toLocaleString()} words`
        : `${wordCount.toLocaleString()} words`;

  return (
    <InputPopover
      label={doc?.wordGoal ? "Word count — edit goal" : "Word count — set a goal"}
      trigger={
        <span className="tabular-nums" aria-live="polite">
          {words} · {minutes} min read
        </span>
      }
      triggerClassName={`${BUTTON} px-3 text-ink-blue`}
      fieldLabel="Word count goal"
      placeholder="e.g. 2000"
      inputMode="numeric"
      initialValue={() => (doc?.wordGoal ? String(doc.wordGoal) : "")}
      validate={(v) => {
        const n = parseWordGoal(v);
        return Number.isFinite(n) && n >= 1 ? null : "Enter a whole number of words, 1 or more.";
      }}
      onApply={(v) => void setWordGoal({ documentId, wordGoal: parseWordGoal(v) })}
      onClear={() => void setWordGoal({ documentId, wordGoal: null })}
      clearLabel="Clear goal"
      canClear={Boolean(doc?.wordGoal)}
    />
  );
}

/** The outline rail beside the page: the document's headings, to jump to. */
export function OutlineRail({
  headings,
  onJump,
}: {
  headings: OutlineHeading[];
  onJump: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Outline"
      className="flex w-full shrink-0 flex-col gap-1 px-4 text-sm md:sticky md:px-0 md:top-10 md:w-52 md:self-start print:hidden"
    >
      <span className="mb-1 font-serif text-lg text-muted">Outline</span>
      {headings.length === 0 ? (
        <p className="text-sm text-muted">Headings you add show up here.</p>
      ) : (
        headings.map((h) => (
          <button
            key={h.nodeId}
            type="button"
            onClick={() => onJump(h.nodeId)}
            style={{ paddingLeft: `${(h.level - 1) * 12 + 10}px` }}
            className="block min-h-9 w-full truncate rounded-md pr-2 text-left text-muted transition hover:bg-chip hover:text-foreground"
          >
            {h.text || "Untitled heading"}
          </button>
        ))
      )}
    </nav>
  );
}

/** The ⋯ menu at the right end of the toolbar: export formats, opening
 *  downward. */
function ExportMenu({ onExport }: { onExport: (format: ExportFormat) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useKeepInViewport<HTMLDivElement>(open);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = async (format: ExportFormat) => {
    setBusy(format);
    setFailed(false);
    try {
      // Close first so the menu isn't on the page when PDF opens the print dialog.
      if (format === "pdf") setOpen(false);
      await onExport(format);
      setOpen(false);
    } catch (err) {
      console.error(`Folio: ${format} export failed`, err);
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          setFailed(false);
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="More: export"
        title="More: export"
        className={`${BUTTON} aria-expanded:bg-chip`}
      >
        ⋯
      </button>
      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label="Export"
          className="absolute right-0 top-11 z-30 w-44 rounded-lg border border-line bg-page p-2 shadow-md"
        >
          <p className="px-2 pb-1 text-xs text-muted">Export as</p>
          {EXPORT_FORMATS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="menuitem"
              disabled={busy !== null}
              onClick={() => void pick(f.id)}
              className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm text-foreground/70 transition hover:bg-black/5 hover:text-foreground disabled:opacity-50 dark:hover:bg-white/10"
            >
              <span>{busy === f.id ? "Exporting…" : f.label}</span>
              <span className="text-xs text-muted">.{f.ext}</span>
            </button>
          ))}
          {failed && (
            <p className="px-2 pt-1 text-xs text-muted" role="alert">
              That export didn&apos;t work — try again.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
