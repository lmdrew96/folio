"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { relativeTime } from "@/lib/time";
import { NewDocButton } from "./NewDocButton";

const UNDO_MS = 8000;

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

  const trimmedQuery = query.trim().toLowerCase();
  const filtered = trimmedQuery
    ? docs.filter((doc) =>
        (doc.title || "Untitled").toLowerCase().includes(trimmedQuery),
      )
    : docs;

  return (
    <>
      <div className="mx-auto w-full max-w-5xl px-6 py-10">
        <div className="mb-6 flex items-center justify-between gap-4">
          <h2 className="font-serif text-2xl text-foreground">
            Your documents
          </h2>
          <NewDocButton />
        </div>
        <label className="sr-only" htmlFor="folio-doc-search">
          Search documents
        </label>
        <input
          id="folio-doc-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search documents…"
          className="mb-6 w-full max-w-xs rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-4 py-2 text-sm text-foreground outline-none transition placeholder:text-foreground/40 focus:ring-2 focus:ring-[var(--folio-attr-sibling)]"
        />
        {filtered.length === 0 ? (
          <p className="py-10 text-center text-foreground/50">
            No documents match &ldquo;{query.trim()}&rdquo;.
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
                    <h3 className="line-clamp-2 pr-6 font-serif text-lg text-foreground">
                      {doc.title || "Untitled"}
                    </h3>
                    <p className="mt-3 text-sm text-foreground/50">
                      edited {relativeTime(doc.updatedAt)}
                    </p>
                  </div>
                </Link>
                <DeleteControl
                  documentId={doc._id}
                  title={doc.title || "Untitled"}
                  onDeleted={handleDeleted}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      {toast}
    </>
  );
}
