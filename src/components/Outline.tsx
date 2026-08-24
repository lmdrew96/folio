"use client";

import { useEffect, useRef, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";

type HeadingItem = { pos: number; level: number; text: string };

function collectHeadings(editor: Editor): HeadingItem[] {
  const items: HeadingItem[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      items.push({
        pos,
        level: (node.attrs.level as number) ?? 1,
        text: node.textContent.trim() || "Untitled heading",
      });
    }
    return true;
  });
  return items;
}

/** Collapsible list of the doc's headings for quick-jump navigation on long
 *  documents — lives with the other floating page controls since, unlike the
 *  Toolbar, it never touches the writing surface itself. */
export function Outline({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const headings = useEditorState({
    editor,
    selector: ({ editor: e }) => collectHeadings(e),
  });

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

  if (headings.length === 0) return null;

  const jumpTo = (pos: number) => {
    editor.chain().focus().setTextSelection(pos).scrollIntoView().run();
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Document outline"
        title="Outline"
        className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] text-foreground/60 shadow-sm transition hover:text-foreground"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-9 left-0 z-30 max-h-80 w-64 overflow-y-auto rounded-lg border border-foreground/10 bg-[var(--folio-paper)] p-2 shadow-md">
          <ul className="flex flex-col gap-0.5">
            {headings.map((h) => (
              <li key={h.pos}>
                <button
                  type="button"
                  onClick={() => jumpTo(h.pos)}
                  style={{ paddingLeft: `${(h.level - 1) * 12 + 8}px` }}
                  className="block w-full truncate rounded px-2 py-1 text-left text-sm text-foreground/70 transition hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                >
                  {h.text}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
