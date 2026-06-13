"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Authenticated, AuthLoading, useMutation, useQuery } from "convex/react";
import { UserButton } from "@clerk/nextjs";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { DocEditor } from "@/components/DocEditor";
import { DiffPanel } from "@/components/DiffPanel";
import { ClaudeReaction } from "@/components/ClaudeReaction";

function DocTitleEditor({ documentId }: { documentId: Id<"documents"> }) {
  const doc = useQuery(api.documents.get, { documentId });
  const rename = useMutation(api.documents.rename);
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);

  // Keep the field synced to the server title whenever we're not mid-edit.
  useEffect(() => {
    if (!focused && doc) setDraft(doc.title);
  }, [doc, focused]);

  if (doc === undefined) {
    return <span className="text-sm text-foreground/40">Loading…</span>;
  }
  if (doc === null) return null;

  const commit = () => {
    const next = draft.trim();
    if (next !== doc.title) {
      void rename({ documentId, title: next }).catch((e) =>
        console.error("Folio: rename failed", e),
      );
    }
    setDraft(next || "Untitled"); // reflect the effective title immediately
  };

  return (
    <input
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
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setDraft(doc.title);
          e.currentTarget.blur();
        }
      }}
      placeholder="Untitled"
      aria-label="Document title"
      className="w-48 max-w-[40vw] truncate rounded bg-transparent px-1.5 py-0.5 text-sm text-foreground/70 outline-none transition placeholder:text-foreground/30 hover:bg-black/5 focus:bg-black/5 focus:text-foreground dark:hover:bg-white/10 dark:focus:bg-white/10"
    />
  );
}

function DocBody({ documentId }: { documentId: Id<"documents"> }) {
  const doc = useQuery(api.documents.get, { documentId });
  if (doc === null) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-16">
        <p className="text-foreground/60">
          This document doesn&apos;t exist or isn&apos;t yours.
        </p>
      </div>
    );
  }
  // key on documentId → a doc switch fully remounts the editor (fresh refs),
  // so load/debounce/hash state never leaks between documents.
  return <DocEditor key={documentId} documentId={documentId} />;
}

export function DocWorkspace({ documentId }: { documentId: Id<"documents"> }) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--folio-backdrop)]">
      <header className="flex shrink-0 items-center justify-between border-b border-black/10 px-6 py-3 dark:border-white/10">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="font-serif text-base font-medium tracking-tight text-foreground"
            title="All documents"
          >
            Folio
          </Link>
          <Authenticated>
            <DocTitleEditor documentId={documentId} />
          </Authenticated>
        </div>
        <UserButton />
      </header>

      <AuthLoading>
        <p className="px-6 py-10 text-black/50 dark:text-white/50">Loading…</p>
      </AuthLoading>
      <Authenticated>
        {/* Editor + diff panel mount only once Convex auth is confirmed, so the
            first blocks/diff query results are always authenticated — no
            empty-then-real race on load. */}
        <div className="flex min-h-0 flex-1">
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <DocBody documentId={documentId} />
          </main>
          <aside className="hidden w-80 shrink-0 flex-col border-l border-black/10 md:flex dark:border-white/10">
            <DiffPanel documentId={documentId} />
            <ClaudeReaction documentId={documentId} />
          </aside>
        </div>
      </Authenticated>
    </div>
  );
}
