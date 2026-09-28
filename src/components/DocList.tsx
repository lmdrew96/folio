"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { relativeTime } from "@/lib/time";
import { NewDocButton } from "./NewDocButton";

const UNDO_MS = 8000;

const SORTS = {
  edited: "Last edited",
  newest: "Newest first",
  oldest: "Oldest first",
  az: "Title A–Z",
  za: "Title Z–A",
} as const;
type SortKey = keyof typeof SORTS;

const FILTERS = { all: "All", mine: "Mine", shared: "Shared with me" } as const;
type FilterKey = keyof typeof FILTERS;

const SORT_KEY = "folio:desk:sort";
const FILTER_KEY = "folio:desk:filter";

/** A remembered desk preference — a per-browser convenience, so any storage
 *  failure (private window, blocked site data) just falls back to the default. */
function readPref<K extends string>(key: string, allowed: Record<K, string>, fallback: K): K {
  try {
    const raw = window.localStorage.getItem(key);
    return raw && raw in allowed ? (raw as K) : fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not remembered this time; nothing else depends on it.
  }
}

const titleOf = (doc: { title: string }) => doc.title || "Untitled";

type DeskDoc = { title: string; createdAt: number; updatedAt: number };
function compareDocs(sort: SortKey): (a: DeskDoc, b: DeskDoc) => number {
  switch (sort) {
    case "newest":
      return (a, b) => b.createdAt - a.createdAt;
    case "oldest":
      return (a, b) => a.createdAt - b.createdAt;
    case "az":
    case "za": {
      const dir = sort === "az" ? 1 : -1;
      // numeric: "Chapter 2" before "Chapter 10".
      return (a, b) =>
        dir * titleOf(a).localeCompare(titleOf(b), undefined, { numeric: true, sensitivity: "base" });
    }
    default:
      return (a, b) => b.updatedAt - a.updatedAt;
  }
}

/** Per-card delete with a calm two-step inline confirm (no scary modal). */
function DeleteControl({
  documentId,
  title,
  onDeleted,
}: {
  documentId: Id<"documents">;
  title: string;
  onDeleted: (documentId: Id<"documents">, title: string) => void;
}) {
  const remove = useMutation(api.documents.remove);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const onDelete = async () => {
    setBusy(true);
    try {
      await remove({ documentId });
      // The row vanishes from the reactive list query on success (soft-deleted
      // server-side — DocList surfaces an Undo toast for the retention window).
      onDeleted(documentId, title);
    } catch {
      setBusy(false);
      setConfirming(false);
    }
  };

  if (confirming) {
    return (
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-1 py-1 shadow-sm">
        <button
          onClick={onDelete}
          disabled={busy}
          className="rounded-full px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40"
        >
          {busy ? "Deleting…" : "Delete"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="rounded-full px-2.5 py-1 text-xs text-foreground/60 hover:text-foreground disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      aria-label={`Delete ${title}`}
      title="Delete document"
      className="absolute right-2 top-2 z-10 rounded-full p-1.5 text-foreground/40 opacity-60 transition hover:bg-black/5 hover:text-foreground/80 hover:opacity-100 focus-visible:opacity-100 dark:hover:bg-white/10"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        <path d="M10 11v6M14 11v6" />
      </svg>
    </button>
  );
}

/** Bottom-docked confirmation for a just-deleted document, with a real Undo —
 *  the delete already soft-deleted server-side, so Undo just clears the
 *  tombstone before the retention window ends. */
function UndoToast({
  title,
  onUndo,
  onDismiss,
}: {
  title: string;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const [undoing, setUndoing] = useState(false);

  useEffect(() => {
    const timer = setTimeout(onDismiss, UNDO_MS);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-4 py-2 text-sm text-foreground shadow-md"
    >
      <span className="max-w-[50vw] truncate">
        Deleted <span className="font-medium">{title}</span>
      </span>
      <button
        onClick={() => {
          setUndoing(true);
          onUndo();
        }}
        disabled={undoing}
        className="shrink-0 font-medium underline-offset-2 hover:underline disabled:opacity-50"
      >
        {undoing ? "…" : "Undo"}
      </button>
    </div>
  );
}

export function DocList() {
  const docs = useQuery(api.documents.list);
  const restore = useMutation(api.documents.restore);
  const [query, setQuery] = useState("");
  // DocList only mounts client-side (inside <Authenticated>), so reading
  // storage in the initializer can't cause a hydration mismatch.
  const [sort, setSort] = useState<SortKey>(() => readPref(SORT_KEY, SORTS, "edited"));
  const [filter, setFilter] = useState<FilterKey>(() => readPref(FILTER_KEY, FILTERS, "all"));
  const [pendingUndo, setPendingUndo] = useState<{
    documentId: Id<"documents">;
    title: string;
  } | null>(null);

  const handleDeleted = useCallback(
    (documentId: Id<"documents">, title: string) => {
      setPendingUndo({ documentId, title });
    },
    [],
  );

  const handleUndo = useCallback(async () => {
    if (!pendingUndo) return;
    try {
      await restore({ documentId: pendingUndo.documentId });
    } catch (e) {
      console.error("Folio: restore failed", e);
    } finally {
      setPendingUndo(null);
    }
  }, [pendingUndo, restore]);

  const toast = pendingUndo && (
    <UndoToast
      title={pendingUndo.title}
      onUndo={handleUndo}
      onDismiss={() => setPendingUndo(null)}
    />
  );

  if (docs === undefined) {
    return (
      <>
        <p className="px-6 py-16 text-center text-foreground/50">Loading…</p>
        {toast}
      </>
    );
  }

  if (docs.length === 0) {
    return (
      <>
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-16 text-center">
          <div className="space-y-2">
            <h2 className="font-serif text-2xl text-foreground">
              Nothing on the desk yet
            </h2>
            <p className="max-w-sm text-balance text-foreground/60">
              Start your first document — Folio will track what changes each
              time you come back to it.
            </p>
          </div>
          <NewDocButton />
        </div>
        {toast}
      </>
    );
  }

  const hasShared = docs.some((d) => d.role === "editor");
  // With nothing shared, "Mine"/"Shared" would be noise — and a remembered
  // "Shared" filter would otherwise strand you on an empty desk.
  const activeFilter: FilterKey = hasShared ? filter : "all";
  const trimmedQuery = query.trim().toLowerCase();
  const filtered = docs
    .filter((doc) =>
      activeFilter === "mine"
        ? doc.role === "owner"
        : activeFilter === "shared"
          ? doc.role === "editor"
          : true,
    )
    .filter((doc) => !trimmedQuery || titleOf(doc).toLowerCase().includes(trimmedQuery))
    .sort(compareDocs(sort));

  return (
    <>
      <div className="mx-auto w-full max-w-5xl px-6 py-10">
        <div className="mb-6 flex items-center justify-between gap-4">
          <h2 className="font-serif text-2xl text-foreground">
            Your documents
          </h2>
          <NewDocButton />
        </div>
        <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3">
          <label className="sr-only" htmlFor="folio-doc-search">
            Search documents
          </label>
          <input
            id="folio-doc-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search documents…"
            className="w-full max-w-xs rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-4 py-2 text-sm text-foreground outline-none transition placeholder:text-foreground/40 focus:ring-2 focus:ring-[var(--folio-attr-sibling)]"
          />
          {hasShared && (
            <div role="group" aria-label="Show" className="flex items-center gap-0.5 rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] p-0.5">
              {(Object.keys(FILTERS) as FilterKey[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={activeFilter === key}
                  onClick={() => {
                    setFilter(key);
                    writePref(FILTER_KEY, key);
                  }}
                  className={`rounded-full px-3 py-1 text-xs transition ${
                    activeFilter === key
                      ? "bg-black/10 text-foreground dark:bg-white/15"
                      : "text-foreground/60 hover:text-foreground"
                  }`}
                >
                  {FILTERS[key]}
                </button>
              ))}
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-foreground/50 sm:ml-auto">
            Sort
            <select
              value={sort}
              onChange={(e) => {
                const next = e.target.value as SortKey;
                setSort(next);
                writePref(SORT_KEY, next);
              }}
              className="rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-3 py-1.5 text-xs text-foreground outline-none focus:ring-2 focus:ring-[var(--folio-attr-sibling)]"
            >
              {(Object.keys(SORTS) as SortKey[]).map((key) => (
                <option key={key} value={key}>
                  {SORTS[key]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {filtered.length === 0 ? (
          <p className="py-10 text-center text-foreground/50">
            {trimmedQuery
              ? <>No documents match &ldquo;{query.trim()}&rdquo;.</>
              : activeFilter === "shared"
                ? "Nothing's been shared with you yet."
                : "No documents here."}
          </p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((doc) => (
              <li key={doc._id} className="relative">
                <Link
                  href={`/doc/${doc._id}`}
                  className="folio-card-link block focus:outline-none"
                >
                  <div className="folio-card flex min-h-32 flex-col justify-between p-5 focus-visible:ring-2 focus-visible:ring-[var(--folio-attr-sibling)]">
                    <div className="flex items-start justify-between gap-2 pr-6">
                      <h3 className="line-clamp-2 font-serif text-lg text-foreground">
                        {doc.title || "Untitled"}
                      </h3>
                      {doc.role === "editor" && (
                        <span className="shrink-0 rounded-full bg-[var(--folio-attr-sibling)]/15 px-2 py-0.5 text-[11px] font-medium text-[var(--folio-attr-sibling)]">
                          Shared
                        </span>
                      )}
                    </div>
                    <p className="mt-3 text-sm text-foreground/50">
                      {sort === "newest" || sort === "oldest"
                        ? `created ${relativeTime(doc.createdAt)}`
                        : `edited ${relativeTime(doc.updatedAt)}`}
                    </p>
                  </div>
                </Link>
                {doc.role === "owner" && (
                  <DeleteControl
                    documentId={doc._id}
                    title={doc.title || "Untitled"}
                    onDeleted={handleDeleted}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {toast}
    </>
  );
}
