"use client";

import Link from "next/link";
import { Authenticated, AuthLoading, useQuery } from "convex/react";
import { UserButton } from "@clerk/nextjs";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Editor } from "@/components/Editor";
import { DiffPanel } from "@/components/DiffPanel";

function DocTitle({ documentId }: { documentId: Id<"documents"> }) {
  const doc = useQuery(api.documents.get, { documentId });
  return (
    <span className="text-sm text-black/50 dark:text-white/50">
      {doc === undefined ? "Loading…" : (doc?.title ?? "Untitled")}
    </span>
  );
}

function DocBody({ documentId }: { documentId: Id<"documents"> }) {
  const doc = useQuery(api.documents.get, { documentId });
  if (doc === null) {
    return (
      <p className="text-black/60 dark:text-white/60">
        This document doesn&apos;t exist or isn&apos;t yours.
      </p>
    );
  }
  // key on documentId → a doc switch fully remounts the editor (fresh refs),
  // so load/debounce/hash state never leaks between documents.
  return <Editor key={documentId} documentId={documentId} />;
}

export function DocWorkspace({ documentId }: { documentId: Id<"documents"> }) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between border-b border-black/10 px-6 py-3 dark:border-white/10">
        <div className="flex items-baseline gap-3">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            Folio
          </Link>
          <Authenticated>
            <DocTitle documentId={documentId} />
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
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-6 py-10">
              <DocBody documentId={documentId} />
            </div>
          </main>
          <DiffPanel documentId={documentId} />
        </div>
      </Authenticated>
    </div>
  );
}
