"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useKeepInViewport } from "@/lib/useKeepInViewport";

/** Local midnight six days ago — today plus the six days before it. */
const weekStart = (): number => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 6);
  return d.getTime();
};

/**
 * "This week on your desk": what you touched and started in the last seven
 * days, by folder, with the words you added to each. A look back, nothing
 * more — no streaks, goals or comparisons with other weeks.
 */
export function WeekRecap({ folderName }: { folderName: (id: Id<"folders">) => string | undefined }) {
  const [since, setSince] = useState<number | null>(null);
  const open = since !== null;
  const recap = useQuery(api.documents.weekRecap, open ? { since } : "skip");
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useKeepInViewport<HTMLDivElement>(open);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setSince(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSince(null);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Folders by their most recently touched document, Unfiled last.
  const groups = new Map<string, NonNullable<typeof recap>>();
  for (const doc of recap ?? []) {
    const name = (doc.folderId && folderName(doc.folderId)) || "Unfiled";
    groups.set(name, [...(groups.get(name) ?? []), doc]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => Number(a === "Unfiled") - Number(b === "Unfiled"));
  const totalWords = (recap ?? []).reduce((n, d) => n + d.wordsAdded, 0);
  const started = (recap ?? []).filter((d) => d.created).length;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setSince(open ? null : weekStart())}
        aria-expanded={open}
        className="rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-4 py-2.5 text-sm text-foreground/80 transition hover:text-foreground"
      >
        This week
      </button>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="This week on your desk"
          className="absolute right-0 top-12 z-30 flex max-h-[70vh] w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-y-auto rounded-lg border border-foreground/10 bg-[var(--folio-paper)] p-4 shadow-md"
        >
          <div>
            <h3 className="font-serif text-lg text-foreground">This week on your desk</h3>
            {recap && recap.length > 0 && (
              <p className="text-xs text-muted">
                {recap.length} {recap.length === 1 ? "document" : "documents"}
                {started > 0 ? ` · ${started} new` : ""}
                {totalWords > 0 ? ` · about ${totalWords.toLocaleString()} words added` : ""}
              </p>
            )}
          </div>
          {recap === undefined ? (
            <p className="text-sm text-muted">Looking back…</p>
          ) : recap.length === 0 ? (
            <p className="text-sm text-muted">Nothing touched in the last seven days. The desk will keep.</p>
          ) : (
            ordered.map(([name, docs]) => (
              <section key={name} className="flex flex-col gap-1">
                <h4 className="text-xs font-medium uppercase tracking-wide text-muted">{name}</h4>
                <ul className="flex flex-col">
                  {docs.map((d) => (
                    <li key={d.id}>
                      <Link
                        href={`/doc/${d.id}`}
                        className="flex items-baseline gap-2 rounded px-1.5 py-1 text-sm text-foreground/80 hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                      >
                        <span className="min-w-0 flex-1 truncate">{d.title || "Untitled"}</span>
                        {d.created && <span className="shrink-0 text-xs text-muted">new</span>}
                        <span className="shrink-0 text-xs text-muted">
                          {d.wordsAdded > 0 ? `+${d.wordsAdded.toLocaleString()} words` : "edited"}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      )}
    </div>
  );
}
