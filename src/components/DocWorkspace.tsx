"use client";

import Link from "next/link";
import { Authenticated, AuthLoading, useQuery } from "convex/react";
import { UserButton } from "@clerk/nextjs";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Editor } from "@/components/Editor";

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
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between border-b border-black/10 px-6 py-3 dark:border-white/10">
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

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
        <AuthLoading>
          <p className="text-black/50 dark:text-white/50">Loading…</p>
        </AuthLoading>
        <Authenticated>
          {/* Editor mounts only once Convex auth is confirmed, so its first
              blocks query result is always authenticated — no empty-then-real
              race that would make the one-shot load latch onto nothing. */}
          <DocBody documentId={documentId} />
        </Authenticated>
      </main>
    </div>
  );
}
