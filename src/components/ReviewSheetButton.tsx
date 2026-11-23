"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { folioClaudeLabel } from "@/lib/identity";
import { useKeepInViewport } from "@/lib/useKeepInViewport";

const MAX_SOURCES = 10;

type SourceDoc = { _id: Id<"documents">; title: string; createdAt: number };

/**
 * From a folder: pick up to ten of its documents and have Cleo turn them into
 * a review sheet — key concepts, definitions, likely exam questions, each
 * linked back to the note it came from. The sheet is a new document in the
 * same folder, written by Cleo; the notes themselves are only read.
 */
export function ReviewSheetButton({
  folderId,
  folderName,
  docs,
}: {
  folderId: Id<"folders">;
  folderName: string;
  docs: SourceDoc[];
}) {
  const label = folioClaudeLabel();
  const router = useRouter();
  const createSheet = useMutation(api.documents.createReviewSheet);

  // Oldest first, so the list reads like the course did.
  const ordered = [...docs].sort((a, b) => a.createdAt - b.createdAt);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<Id<"documents">>>(new Set());
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useKeepInViewport<HTMLDivElement>(open);

  useEffect(() => {
    if (!open || working) return;
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
  }, [open, working]);

  if (docs.length === 0) return null;

  const toggleOpen = () => {
    if (!open) {
      // The ten most recent notes, by default.
      setPicked(new Set(ordered.slice(-MAX_SOURCES).map((d) => d._id)));
      setError(null);
    }
    setOpen((o) => !o);
  };

  const toggle = (id: Id<"documents">) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_SOURCES) next.add(id);
      return next;
    });

  const make = async () => {
    setWorking(true);
    setError(null);
    try {
      const res = await fetch("/api/cleo/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentIds: ordered.filter((d) => picked.has(d._id)).map((d) => d._id),
          course: folderName,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || `Request failed (${res.status})`);
      const { markdown } = (await res.json()) as { markdown: string };

      // Markdown → BlockNote blocks → rows, in the browser (BlockNote's parser
      // needs a DOM). Loaded on demand so the desk doesn't carry the editor.
      const [{ BlockNoteEditor }, { toRows }] = await Promise.all([
        import("@blocknote/core"),
        import("@/blocknote/rows"),
      ]);
      const blocks = await BlockNoteEditor.create().tryParseMarkdownToBlocks(markdown);
      const rows = toRows(blocks as unknown as Parameters<typeof toRows>[0]);
      const id = await createSheet({ folderId, title: `Review sheet — ${folderName}`, blocks: rows });
      router.push(`/doc/${id}`);
    } catch (e) {
      console.error("Folio: review sheet failed", e);
      setError(e instanceof Error ? e.message : "Couldn't make the review sheet.");
      setWorking(false);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        className="rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-4 py-2.5 text-sm text-foreground/80 transition hover:text-foreground"
      >
        Review sheet
      </button>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Make a review sheet"
          className="absolute right-0 top-12 z-30 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border border-foreground/10 bg-[var(--folio-paper)] p-3 shadow-md"
        >
          <p className="text-sm text-foreground/80">
            {label} reads the notes you pick and writes a review sheet: key concepts, definitions and
            likely exam questions, each linked to its note. It lands here as a new document.
          </p>
          <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
            {ordered.map((d) => {
              const checked = picked.has(d._id);
              return (
                <li key={d._id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm text-foreground/70 hover:bg-black/5 dark:hover:bg-white/10">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={working || (!checked && picked.size >= MAX_SOURCES)}
                      onChange={() => toggle(d._id)}
                    />
                    <span className="min-w-0 flex-1 truncate">{d.title || "Untitled"}</span>
                    <span className="shrink-0 text-xs text-muted">
                      {new Date(d.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted">
            {picked.size} of up to {MAX_SOURCES} picked
          </p>
          {error && (
            <p className="text-xs text-red-700 dark:text-red-300" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={() => void make()}
            disabled={working || picked.size === 0}
            className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {working ? `${label} is writing it…` : "Make review sheet"}
          </button>
        </div>
      )}
    </div>
  );
}
