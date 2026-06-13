"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useEditorState, type Editor } from "@tiptap/react";

// Curated highlight tints — light enough to keep ink text readable.
const HIGHLIGHTS = [
  { name: "Amber", color: "#f4e3be" },
  { name: "Green", color: "#d6ebc8" },
  { name: "Mint", color: "#cfe6e2" },
  { name: "Lavender", color: "#e5dfee" },
];

// Curated accent text colors — mid-tone brand hues that stay legible on both
// the light paper and the dark sheet (deep colors would vanish in dark mode).
const TEXT_COLORS = [
  { name: "Olive", color: "#849440" },
  { name: "Gold", color: "#dfa649" },
  { name: "Teal", color: "#8cbdb9" },
  { name: "Mauve", color: "#88739e" },
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
  swatches: { name: string; color: string }[];
  onPick: (color: string) => void;
  onClear: () => void;
  clearLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-expanded={open}
        title={label}
        className={`${BTN} ${open ? BTN_ACTIVE : ""}`}
      >
        {trigger}
      </button>
      {open && (
        <div className="absolute left-0 top-9 z-30 flex items-center gap-1 rounded-lg border border-foreground/10 bg-[var(--folio-paper)] p-1.5 shadow-md">
          {swatches.map((s) => (
            <button
              key={s.color}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(s.color);
                setOpen(false);
              }}
              aria-label={s.name}
              title={s.name}
              className="h-5 w-5 rounded-full border border-black/15 transition hover:scale-110 dark:border-white/20"
              style={{ background: s.color }}
            />
          ))}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onClear();
              setOpen(false);
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

export function Toolbar({ editor }: { editor: Editor }) {
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
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      blockquote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
      alignCenter: e.isActive({ textAlign: "center" }),
      alignRight: e.isActive({ textAlign: "right" }),
      highlight: e.isActive("highlight"),
    }),
  });

  const blockValue = s.h1
    ? "h1"
    : s.h2
      ? "h2"
      : s.h3
        ? "h3"
        : "paragraph";
  const alignValue = s.alignCenter ? "center" : s.alignRight ? "right" : "left";

  const setBlock = (value: string) => {
    const chain = editor.chain().focus();
    if (value === "h1") chain.setHeading({ level: 1 }).run();
    else if (value === "h2") chain.setHeading({ level: 2 }).run();
    else if (value === "h3") chain.setHeading({ level: 3 }).run();
    else chain.setParagraph().run();
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
    <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-foreground/10 bg-[var(--folio-backdrop)] px-3 py-1.5">
      {/* Block type */}
      <label className="sr-only" htmlFor="folio-block-type">
        Paragraph style
      </label>
      <select
        id="folio-block-type"
        value={blockValue}
        onChange={(e) => setBlock(e.target.value)}
        className="h-8 rounded-md bg-transparent px-1.5 text-sm text-foreground/80 outline-none transition hover:bg-black/5 focus:bg-black/5 dark:hover:bg-white/10 dark:focus:bg-white/10"
        title="Paragraph style"
      >
        <option value="paragraph">Paragraph</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>

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
        trigger={<span className="rounded-sm bg-[#f4e3be] px-1 text-[#1e1830]">H</span>}
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
    </div>
  );
}
