"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { InputPopover } from "./InputPopover";

/** Same key as the TipTap editor, so the preference carries over. */
const WORD_COUNT_KEY = "folio:wordCount:visible";

export type OutlineHeading = { nodeId: string; level: number; text: string };

export const countWords = (text: string): number => {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
};

const parseWordGoal = (input: string) => Math.round(Number(input.replace(/[,\s_]/g, "")));

/**
 * The SuperDoc editor's floating page controls (bottom-left): the outline
 * jump-list and the word count / goal badge. Mirrors the TipTap editor's
 * controls; the numbers come from the editor's extraction pass rather than
 * from a ProseMirror editor.
 */
export function SuperDocFooter({
  documentId,
  headings,
  wordCount,
  selectedWordCount,
  onJump,
  pagePreview,
}: {
  documentId: Id<"documents">;
  headings: OutlineHeading[];
  wordCount: number;
  selectedWordCount: number;
  onJump: (nodeId: string) => void;
  /** On mobile the layout switch lives here, not in the toolbar's overflow
   *  menu: Pages is a read-only preview, Continuous is where you edit. */
  pagePreview?: { active: boolean; toggle: () => void };
}) {
  const doc = useQuery(api.documents.get, { documentId });
  const setWordGoal = useMutation(api.documents.setWordGoal);

  const [visible, setVisible] = useState(() => {
    try {
      return localStorage.getItem(WORD_COUNT_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setVisible((prev) => {
      try {
        localStorage.setItem(WORD_COUNT_KEY, prev ? "0" : "1");
      } catch {
        // not persisted; still toggles for this session
      }
      return !prev;
    });

  return (
    <div className="fixed bottom-5 left-5 z-20 flex items-center gap-2">
      <OutlineMenu headings={headings} onJump={onJump} />
      <button
        onClick={toggle}
        aria-pressed={visible}
        title={
          !visible
            ? "Show word count"
            : selectedWordCount > 0
              ? "Words in selection / in document — click to hide"
              : "Hide word count"
        }
        className="rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-3 py-1 text-xs text-foreground/60 shadow-sm transition hover:text-foreground"
      >
        {!visible
          ? "Word count"
          : selectedWordCount > 0
            ? `${selectedWordCount.toLocaleString()}/${wordCount.toLocaleString()} words`
            : doc?.wordGoal
              ? `${wordCount.toLocaleString()} / ${doc.wordGoal.toLocaleString()} words`
              : `${wordCount.toLocaleString()} words`}
      </button>
      {visible && (
        <InputPopover
          label={doc?.wordGoal ? "Edit word goal" : "Set a word goal"}
          trigger={doc?.wordGoal ? "Edit goal" : "Set goal"}
          triggerClassName="rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-2 py-1 text-xs text-foreground/40 shadow-sm transition hover:text-foreground"
          fieldLabel="Word count goal"
          placeholder="e.g. 2000"
          inputMode="numeric"
          placement="above"
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
      )}
      {pagePreview && (
        <button
          onClick={pagePreview.toggle}
          aria-pressed={pagePreview.active}
          className="rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-3 py-1 text-xs text-foreground/60 shadow-sm transition hover:text-foreground"
        >
          {pagePreview.active ? "Edit" : "Page preview"}
        </button>
      )}
    </div>
  );
}

/** Collapsible jump-list of the document's headings. */
function OutlineMenu({
  headings,
  onJump,
}: {
  headings: OutlineHeading[];
  onJump: (nodeId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
              <li key={h.nodeId}>
                <button
                  type="button"
                  onClick={() => {
                    onJump(h.nodeId);
                    setOpen(false);
                  }}
                  style={{ paddingLeft: `${(h.level - 1) * 12 + 8}px` }}
                  className="block w-full truncate rounded px-2 py-1 text-left text-sm text-foreground/70 transition hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                >
                  {h.text || "Untitled heading"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
