"use client";

import { useState, type ReactNode } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { useDropdownMenu } from "@/lib/useDropdownMenu";
import {
  exportDocument,
  EXPORT_FORMATS,
  type ExportFormat,
} from "@/lib/export";
import { FONT_OPTIONS, fontOption, type FontOption } from "@/lib/fonts";
import { insertFootnote } from "./extensions/footnote";
// The tier size table lives with the FontSize extension — it's the same
// table the list-marker decoration reads, so there's one source of truth.
import { DEFAULT_FONT_SIZE, HEADING_FONT_SIZES } from "./extensions/font-size";

// Curated highlights. `value` is the semantic name stored on the mark (themed
// in CSS); `display` is the light-mode tint shown in the swatch. The stored
// values (amber/green/mint/lavender) stay put even as the palette moves on,
// so highlights already saved in a document keep resolving to a CSS rule.
const HIGHLIGHTS = [
  { name: "Amber", value: "amber", display: "#ffd7c3" },
  { name: "Sage", value: "green", display: "#c6c3ba" },
  { name: "Slate", value: "mint", display: "#c6c6cb" },
  { name: "Plum", value: "lavender", display: "#cdc1c8" },
];

// Curated accent text colors — mid-tone brand hues that stay legible on both
// the light paper and the dark sheet (deep colors would vanish in dark mode).
const TEXT_COLORS = [
  { name: "Poppy", value: "#CF4A4D", display: "#CF4A4D" },
  { name: "Mecca", value: "#DC7668", display: "#DC7668" },
  { name: "Usugaki", value: "#FFA67A", display: "#FFA67A" },
  { name: "Herbs", value: "#817965", display: "#817965" },
];

// The block-type <select>'s values, and the heading level each maps to.
type BlockValue = "paragraph" | "h1" | "h2" | "h3" | "h4";
const HEADING_LEVELS = { h1: 1, h2: 2, h3: 3, h4: 4 } as const;

// Standard word-processor multiples (Single/1.15/1.5/Double), not vague
// relative labels — matches what Word/Docs call these so the number you pick
// is the number you get, not a guess at what "Relaxed" means in px.
const LINE_SPACINGS = [
  { label: "Default", value: "" },
  { label: "Single", value: "1" },
  { label: "1.15", value: "1.15" },
  { label: "1.5", value: "1.5" },
  { label: "Double", value: "2" },
];

const BTN =
  "flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-sm leading-none text-foreground/60 transition hover:bg-black/5 hover:text-foreground disabled:opacity-40 dark:hover:bg-white/10";
const BTN_ACTIVE = "bg-black/10 text-foreground dark:bg-white/15";

function ToolButton({
  onClick,
  active,
  label,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      // Keep the editor's text selection — don't let the button steal focus.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={`${BTN} ${active ? BTN_ACTIVE : ""}`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px self-center bg-foreground/10" />;
}

// --- minimal inline icons (stroke-based, 16px) ---
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
const BulletIcon = (
  <Icon>
    <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
  </Icon>
);
const OrderedIcon = (
  <Icon>
    <path d="M10 6h10M10 12h10M10 18h10M4 4v4M4 8H3M3 8h2" />
  </Icon>
);
const QuoteIcon = (
  <Icon>
    <path d="M6 17h3l2-4V7H5v6h3zM14 17h3l2-4V7h-6v6h3z" />
  </Icon>
);
const LinkIcon = (
  <Icon>
    <path d="M10 13a5 5 0 0 0 7 0l1-1a5 5 0 0 0-7-7l-1 1" />
    <path d="M14 11a5 5 0 0 0-7 0l-1 1a5 5 0 0 0 7 7l1-1" />
  </Icon>
);
const FootnoteIcon = (
  <Icon>
    <path d="M6 5v10M6 5l3 2M6 5l-3 2" />
    <path d="M13 19h6M13 19l1.8-1.8a1.8 1.8 0 1 0-1.8-1.8" />
  </Icon>
);
const AlignLeftIcon = (
  <Icon>
    <path d="M4 6h16M4 12h10M4 18h13" />
  </Icon>
);
const AlignCenterIcon = (
  <Icon>
    <path d="M4 6h16M7 12h10M5 18h14" />
  </Icon>
);
const AlignRightIcon = (
  <Icon>
    <path d="M4 6h16M10 12h10M7 18h13" />
  </Icon>
);
const LineSpacingIcon = (
  <Icon>
    <path d="M9 6h11M9 12h11M9 18h11M4 4v16M4 4 2 6M4 4l2 2M4 20l-2-2M4 20l2-2" />
  </Icon>
);
const ExportIcon = (
  <Icon>
    <path d="M12 3v12M8 11l4 4 4-4M5 21h14" />
  </Icon>
);
const MoreIcon = (
  <Icon>
    <path d="M5 12h.01M12 12h.01M19 12h.01" />
  </Icon>
);

function SwatchPopover({
  label,
  trigger,
  swatches,
  onPick,
  onClear,
  clearLabel,
}: {
  label: string;
  trigger: ReactNode;
  swatches: { name: string; value: string; display: string }[];
  onPick: (value: string) => void;
  onClear: () => void;
  clearLabel: string;
}) {
  const { open, setOpen, close, rootRef, triggerRef, onTriggerKeyDown, onPanelKeyDown } =
    useDropdownMenu();

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        title={label}
        className={`${BTN} ${open ? BTN_ACTIVE : ""}`}
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          onKeyDown={onPanelKeyDown}
          className="absolute left-0 top-9 z-30 flex items-center gap-1 rounded-lg border border-foreground/10 bg-[var(--folio-paper)] p-1.5 shadow-md"
        >
          {swatches.map((s) => (
            <button
              key={s.value}
              type="button"
              role="menuitem"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(s.value);
                close();
              }}
              aria-label={s.name}
              title={s.name}
              className="h-5 w-5 rounded-full border border-black/15 transition hover:scale-110 dark:border-white/20"
              style={{ background: s.display }}
            />
          ))}
          <button
            type="button"
            role="menuitem"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onClear();
              close();
            }}
            className="ml-1 flex h-5 items-center rounded px-1.5 text-xs text-foreground/60 transition hover:text-foreground"
          >
            {clearLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function LineSpacingControl({
  editor,
  current,
}: {
  editor: Editor;
  current: string;
}) {
  const { open, setOpen, close, rootRef, triggerRef, onTriggerKeyDown, onPanelKeyDown } =
    useDropdownMenu();

  const apply = (value: string) => {
    if (value) editor.chain().focus().setLineHeight(value).run();
    else editor.chain().focus().unsetLineHeight().run();
    close();
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        aria-label="Line spacing"
        aria-expanded={open}
        aria-haspopup="menu"
        title="Line spacing"
        className={`${BTN} ${open ? BTN_ACTIVE : ""}`}
      >
        {LineSpacingIcon}
      </button>
      {open && (
        <div
          role="menu"
          onKeyDown={onPanelKeyDown}
          className="absolute right-0 top-9 z-30 w-32 overflow-hidden rounded-lg border border-foreground/10 bg-[var(--folio-paper)] py-1 shadow-md"
        >
          {LINE_SPACINGS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitem"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => apply(o.value)}
              className={`flex w-full items-center justify-between px-3 py-1.5 text-sm transition hover:bg-black/5 dark:hover:bg-white/10 ${
                current === o.value ? "text-foreground" : "text-foreground/60"
              }`}
            >
              <span>{o.label}</span>
              {current === o.value && <span className="text-xs">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const FONT_GROUPS: { label: string; category: FontOption["category"] }[] = [
  { label: "Serif", category: "serif" },
  { label: "Sans", category: "sans" },
  { label: "Mono", category: "mono" },
];

function FontFamilyControl({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (key: string) => void;
}) {
  const { open, setOpen, close, rootRef, triggerRef, onTriggerKeyDown, onPanelKeyDown } =
    useDropdownMenu();

  const current = fontOption(value);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        aria-label="Font"
        aria-expanded={open}
        aria-haspopup="menu"
        title="Font"
        className={`${BTN} w-auto px-2 text-xs ${open ? BTN_ACTIVE : ""}`}
      >
        {current.label}
      </button>
      {open && (
        <div
          role="menu"
          onKeyDown={onPanelKeyDown}
          className="absolute left-0 top-9 z-30 w-48 overflow-hidden rounded-lg border border-foreground/10 bg-[var(--folio-paper)] py-1 shadow-md"
        >
          {FONT_GROUPS.map((group) => (
            <div key={group.category}>
              <p className="px-3 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground/35">
                {group.label}
              </p>
              {FONT_OPTIONS.filter((f) => f.category === group.category).map((f) => (
                <button
                  key={f.key}
                  type="button"
                  role="menuitem"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(f.key);
                    close();
                  }}
                  style={{ fontFamily: `var(${f.variable}), ${f.fallback}` }}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-sm transition hover:bg-black/5 dark:hover:bg-white/10 ${
                    current.key === f.key ? "text-foreground" : "text-foreground/60"
                  }`}
                >
                  <span>{f.label}</span>
                  {current.key === f.key && <span className="text-xs">✓</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FontSizeControl({ editor, current }: { editor: Editor; current: string }) {
  const currentPx = current.replace(/px$/, "");
  const [draft, setDraft] = useState(currentPx);
  const [focused, setFocused] = useState(false);
  const [syncedPx, setSyncedPx] = useState(currentPx);

  // Stay in sync with the selection's actual size (e.g. clicking into a
  // differently-sized block) without clobbering what's still being typed —
  // same "store the previous value, adjust during render" pattern as
  // DocTitleEditor's title sync, not a setState-in-effect.
  if (!focused && currentPx !== syncedPx) {
    setSyncedPx(currentPx);
    setDraft(currentPx);
  }

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      editor.chain().focus().unsetFontSize().run();
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) {
      setDraft(currentPx); // invalid — revert to the current value
      return;
    }
    const clamped = Math.min(160, Math.max(6, Math.round(n)));
    setDraft(String(clamped));
    editor.chain().focus().setFontSize(`${clamped}px`).run();
  };

  return (
    <input
      type="number"
      inputMode="numeric"
      min={6}
      max={160}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setDraft(currentPx);
          e.currentTarget.blur();
        }
      }}
      placeholder="Size"
      aria-label="Font size in pixels"
      title="Font size (px) — Default when empty"
      className="h-8 w-14 rounded-md bg-transparent px-1.5 text-sm text-foreground/80 outline-none transition placeholder:text-foreground/40 hover:bg-black/5 focus:bg-black/5 dark:hover:bg-white/10 dark:focus:bg-white/10"
    />
  );
}

function ExportMenu({ editor, title }: { editor: Editor; title: string }) {
  const { open, setOpen, close, rootRef, triggerRef, onTriggerKeyDown, onPanelKeyDown } =
    useDropdownMenu();
  const [busy, setBusy] = useState<ExportFormat | null>(null);

  const pick = async (format: ExportFormat) => {
    close();
    setBusy(format);
    try {
      await exportDocument(editor, title, format);
    } catch (err) {
      console.error("Folio: export failed", err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        aria-label="Export document"
        aria-expanded={open}
        aria-haspopup="menu"
        title="Export document"
        className={`${BTN} ${open ? BTN_ACTIVE : ""}`}
      >
        {ExportIcon}
      </button>
      {open && (
        <div
          role="menu"
          onKeyDown={onPanelKeyDown}
          className="absolute right-0 top-9 z-30 w-40 overflow-hidden rounded-lg border border-foreground/10 bg-[var(--folio-paper)] py-1 shadow-md"
        >
          {EXPORT_FORMATS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="menuitem"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(f.id)}
              disabled={busy !== null}
              className="flex w-full items-center justify-between px-3 py-1.5 text-sm text-foreground/70 transition hover:bg-black/5 hover:text-foreground disabled:opacity-50 dark:hover:bg-white/10"
            >
              <span>{f.label}</span>
              <span className="text-[11px] uppercase text-foreground/35">
                {busy === f.id ? "…" : `.${f.ext}`}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Font family/size, line spacing, and export are the toolbar's "secondary"
// controls — below `sm` they'd otherwise push the row to 2-3 lines above the
// page, so they collapse here and reappear inline at `sm` and up.
function MoreMenu({
  editor,
  title,
  fontFamily,
  onFontFamilyChange,
  fontSize,
  lineHeight,
}: {
  editor: Editor;
  title: string;
  fontFamily: string | undefined;
  onFontFamilyChange: (key: string) => void;
  fontSize: string;
  lineHeight: string;
}) {
  const { open, setOpen, rootRef, triggerRef, onTriggerKeyDown, onPanelKeyDown } =
    useDropdownMenu();

  return (
    <div ref={rootRef} className="relative sm:hidden">
      <button
        ref={triggerRef}
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        aria-label="More formatting options"
        aria-expanded={open}
        aria-haspopup="menu"
        title="More"
        className={`${BTN} ${open ? BTN_ACTIVE : ""}`}
      >
        {MoreIcon}
      </button>
      {open && (
        <div
          role="menu"
          onKeyDown={onPanelKeyDown}
          className="absolute right-0 top-9 z-30 flex w-56 flex-col gap-2 rounded-lg border border-foreground/10 bg-[var(--folio-paper)] p-2 shadow-md"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-foreground/50">Font</span>
            <FontFamilyControl value={fontFamily} onChange={onFontFamilyChange} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-foreground/50">Size</span>
            <FontSizeControl editor={editor} current={fontSize} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-foreground/50">Line spacing</span>
            <LineSpacingControl editor={editor} current={lineHeight} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-foreground/50">Export</span>
            <ExportMenu editor={editor} title={title} />
          </div>
        </div>
      )}
    </div>
  );
}

export function Toolbar({
  editor,
  title,
  fontFamily,
  onFontFamilyChange,
}: {
  editor: Editor;
  title: string;
  fontFamily: string | undefined;
  onFontFamilyChange: (key: string) => void;
}) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      link: e.isActive("link"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      h4: e.isActive("heading", { level: 4 }),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      blockquote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
      alignCenter: e.isActive({ textAlign: "center" }),
      alignRight: e.isActive({ textAlign: "right" }),
      highlight: e.isActive("highlight"),
      headingLevel: (e.getAttributes("heading").level as number | undefined) ?? 0,
      lineHeight:
        e.getAttributes("paragraph").lineHeight ||
        e.getAttributes("heading").lineHeight ||
        "",
      // Show the tier's real rendered default rather than a blank dial: 11px
      // for body text, or the active heading level's own size (see
      // .ProseMirror p / h1..h4 in globals.css). An explicit per-block
      // override, when there is one, still wins.
      fontSize:
        e.getAttributes("paragraph").fontSize ||
        e.getAttributes("heading").fontSize ||
        HEADING_FONT_SIZES[e.getAttributes("heading").level as number] ||
        DEFAULT_FONT_SIZE,
    }),
  });

  const blockValue = s.h1
    ? "h1"
    : s.h2
      ? "h2"
      : s.h3
        ? "h3"
        : s.h4
          ? "h4"
          : "paragraph";
  const alignValue = s.alignCenter ? "center" : s.alignRight ? "right" : "left";

  // Switching tier also clears any manual size override, so a tier is actually
  // a size: picking "Heading 2" gives you 16px instead of silently keeping the
  // 40px you'd typed while the same block was an H1.
  const setBlock = (value: BlockValue) => {
    const chain = editor.chain().focus();
    if (value === "paragraph") chain.setParagraph();
    else chain.setHeading({ level: HEADING_LEVELS[value] });
    chain.unsetFontSize().run();
  };

  const onLink = () => {
    if (s.link) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", prev ?? "https://");
    if (url === null) return; // cancelled
    if (url.trim() === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: url.trim() })
      .run();
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-foreground/10 bg-[var(--folio-backdrop)] px-3 py-1.5 print:hidden">
      {/* Block type */}
      <label className="sr-only" htmlFor="folio-block-type">
        Paragraph style
      </label>
      <select
        id="folio-block-type"
        value={blockValue}
        onChange={(e) => setBlock(e.target.value as BlockValue)}
        className="h-8 rounded-md bg-transparent px-1.5 text-sm text-foreground/80 outline-none transition hover:bg-black/5 focus:bg-black/5 dark:hover:bg-white/10 dark:focus:bg-white/10"
        title="Paragraph style"
      >
        <option value="paragraph">Paragraph</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
        <option value="h4">Heading 4</option>
      </select>

      <div className="hidden items-center gap-0.5 sm:flex">
        <FontFamilyControl value={fontFamily} onChange={onFontFamilyChange} />
        <FontSizeControl editor={editor} current={s.fontSize} />
      </div>

      <Divider />

      {/* Inline marks */}
      <ToolButton
        label="Bold"
        active={s.bold}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <span className="font-bold">B</span>
      </ToolButton>
      <ToolButton
        label="Italic"
        active={s.italic}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <span className="font-serif italic">I</span>
      </ToolButton>
      <ToolButton
        label="Underline"
        active={s.underline}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        <span className="underline">U</span>
      </ToolButton>
      <ToolButton
        label="Strikethrough"
        active={s.strike}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <span className="line-through">S</span>
      </ToolButton>
      <ToolButton
        label="Inline code"
        active={s.code}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        <span className="font-mono text-xs">{"</>"}</span>
      </ToolButton>
      <ToolButton label={s.link ? "Remove link" : "Add link"} active={s.link} onClick={onLink}>
        {LinkIcon}
      </ToolButton>
      <ToolButton label="Insert footnote" onClick={() => insertFootnote(editor)}>
        {FootnoteIcon}
      </ToolButton>

      <Divider />

      {/* Color + highlight */}
      <SwatchPopover
        label="Text color"
        trigger={
          <span className="font-semibold underline decoration-2 underline-offset-2">
            A
          </span>
        }
        swatches={TEXT_COLORS}
        onPick={(color) => editor.chain().focus().setColor(color).run()}
        onClear={() => editor.chain().focus().unsetColor().run()}
        clearLabel="Default"
      />
      <SwatchPopover
        label="Highlight"
        trigger={<span className="rounded-sm bg-[#ffd7c3] px-1 text-[#20161e]">H</span>}
        swatches={HIGHLIGHTS}
        onPick={(color) =>
          editor.chain().focus().setHighlight({ color }).run()
        }
        onClear={() => editor.chain().focus().unsetHighlight().run()}
        clearLabel="None"
      />

      <Divider />

      {/* Block toggles */}
      <ToolButton
        label="Bullet list"
        active={s.bulletList}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        {BulletIcon}
      </ToolButton>
      <ToolButton
        label="Numbered list"
        active={s.orderedList}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        {OrderedIcon}
      </ToolButton>
      <ToolButton
        label="Quote"
        active={s.blockquote}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        {QuoteIcon}
      </ToolButton>
      <ToolButton
        label="Code block"
        active={s.codeBlock}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      >
        <span className="font-mono text-xs">{"{}"}</span>
      </ToolButton>

      <Divider />

      {/* Alignment */}
      <ToolButton
        label="Align left"
        active={alignValue === "left"}
        onClick={() => editor.chain().focus().setTextAlign("left").run()}
      >
        {AlignLeftIcon}
      </ToolButton>
      <ToolButton
        label="Align center"
        active={alignValue === "center"}
        onClick={() => editor.chain().focus().setTextAlign("center").run()}
      >
        {AlignCenterIcon}
      </ToolButton>
      <ToolButton
        label="Align right"
        active={alignValue === "right"}
        onClick={() => editor.chain().focus().setTextAlign("right").run()}
      >
        {AlignRightIcon}
      </ToolButton>

      <div className="hidden items-center gap-0.5 sm:flex">
        <Divider />

        {/* Line spacing */}
        <LineSpacingControl editor={editor} current={s.lineHeight} />

        <Divider />

        {/* Export */}
        <ExportMenu editor={editor} title={title} />
      </div>

      <MoreMenu
        editor={editor}
        title={title}
        fontFamily={fontFamily}
        onFontFamilyChange={onFontFamilyChange}
        fontSize={s.fontSize}
        lineHeight={s.lineHeight}
      />
    </div>
  );
}
