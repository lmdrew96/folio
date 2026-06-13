"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { relativeTime } from "@/lib/time";
import { NewDocButton } from "./NewDocButton";

/** Per-card delete with a calm two-step inline confirm (no scary modal). */
function DeleteControl({
  documentId,
  title,
}: {
  documentId: Id<"documents">;
  title: string;
}) {
  const remove = useMutation(api.documents.remove);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const onDelete = async () => {
    setBusy(true);
    try {
      await remove({ documentId });
      // The row vanishes from the reactive list query on success.
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

export function DocList() {
  const docs = useQuery(api.documents.list);

  if (docs === undefined) {
    return (
      <p className="px-6 py-16 text-center text-foreground/50">Loading…</p>
    );
  }

  if (docs.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-16 text-center">
        <div className="space-y-2">
          <h2 className="font-serif text-2xl text-foreground">
            Nothing on the desk yet
          </h2>
          <p className="max-w-sm text-balance text-foreground/60">
            Start your first document — Folio will track what changes each time
            you come back to it.
          </p>
        </div>
        <NewDocButton />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="font-serif text-2xl text-foreground">Your documents</h2>
        <NewDocButton />
      </div>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {docs.map((doc) => (
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
            <DeleteControl documentId={doc._id} title={doc.title || "Untitled"} />
          </li>
        ))}
      </ul>
    </div>
  );
}
