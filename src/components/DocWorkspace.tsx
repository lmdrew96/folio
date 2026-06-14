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
import { ResizableDock } from "@/components/ResizableDock";
import { ThemeToggle } from "@/components/ThemeToggle";
import { folioClaudeLabel } from "@/lib/identity";

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

/** Opens the changes/Cleo drawer on screens too narrow for the persistent
 *  sidebar. Carries a badge of how many changes are waiting behind it. */
function PanelToggle({
  documentId,
  onClick,
}: {
  documentId: Id<"documents">;
  onClick: () => void;
}) {
  const diff = useQuery(api.diff.diffSince, { documentId, userId: "nae" });
  const total = diff
    ? diff.added.length + diff.edited.length + diff.deleted.length
    : 0;

  return (
    <button
      onClick={onClick}
      aria-label={`Changes and ${folioClaudeLabel()}`}
      title={`Changes & ${folioClaudeLabel()}`}
      className="relative flex h-8 w-8 items-center justify-center rounded-md text-foreground/60 transition hover:bg-black/5 hover:text-foreground lg:hidden dark:hover:bg-white/10"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <line x1="15" y1="4" x2="15" y2="20" />
      </svg>
      {total > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[10px] font-medium text-background">
          {total}
        </span>
      )}
    </button>
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
  const [panelOpen, setPanelOpen] = useState(false);
  const label = folioClaudeLabel();

  // Escape closes the drawer.
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen]);

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
        <div className="flex items-center gap-1">
          <Authenticated>
            <PanelToggle
              documentId={documentId}
              onClick={() => setPanelOpen(true)}
            />
          </Authenticated>
          <ThemeToggle />
          <UserButton />
        </div>
      </header>

      <AuthLoading>
        <p className="px-6 py-10 text-foreground/50">Loading…</p>
      </AuthLoading>
      <Authenticated>
        {/* Editor + diff panel mount only once Convex auth is confirmed, so the
            first blocks/diff query results are always authenticated — no
            empty-then-real race on load. */}
        <div className="flex min-h-0 flex-1">
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <DocBody documentId={documentId} />
          </main>
          {/* Resizable sidebar on wide screens; a drawer below lg. */}
          <ResizableDock documentId={documentId} />
        </div>

        {/* Drawer for small/medium screens — same panels, slid in from the right. */}
        {panelOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button
              aria-label="Close panel"
              onClick={() => setPanelOpen(false)}
              className="absolute inset-0 cursor-default bg-black/30"
            />
            <aside
              role="dialog"
              aria-modal="true"
              aria-label={`Changes and ${label}`}
              className="absolute inset-y-0 right-0 flex w-[88%] max-w-sm flex-col bg-[var(--folio-backdrop)] shadow-xl"
            >
              <div className="flex shrink-0 items-center justify-between border-b border-black/10 px-4 py-3 dark:border-white/10">
                <span className="text-sm font-semibold text-foreground">
                  Changes &amp; {label}
                </span>
                <button
                  onClick={() => setPanelOpen(false)}
                  aria-label="Close panel"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/60 transition hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <DiffPanel documentId={documentId} />
              </div>
              <div className="max-h-[45%] shrink-0 overflow-hidden border-t border-black/10 dark:border-white/10">
                <ClaudeReaction documentId={documentId} />
              </div>
            </aside>
          </div>
        )}
      </Authenticated>
    </div>
  );
}
