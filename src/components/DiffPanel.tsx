"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { relativeTime } from "@/lib/time";
import { Markdown } from "@/components/Markdown";

type DiffPart = { value: string; added?: boolean; removed?: boolean };

type Item = {
  blockId: string;
  type: string;
  preview: string;
  diff?: DiffPart[];
  markdown?: string;
  author?: string;
  authorName?: string;
  at: number;
};

const KINDS = {
  added: { label: "Added", className: "bg-coral/15 text-foreground" },
  edited: { label: "Edited", className: "bg-ink-blue/15 text-foreground" },
  deleted: { label: "Deleted", className: "bg-chip text-muted" },
} as const;

// Word-level before/after for an edited block — removed spans strike through
// in the muted ink of the "Deleted" badge, added spans take the coral
// highlight wash, so the diff reuses the panel's own palette.
function DiffText({ parts }: { parts: DiffPart[] }) {
  return (
    <p className="line-clamp-3 break-words text-sm text-black/70 dark:text-white/70">
      {parts.map((part, i) =>
        part.removed ? (
          <span key={i} className="text-muted line-through">
            {part.value}
          </span>
        ) : part.added ? (
          <span key={i} className="bg-highlight text-foreground">
            {part.value}
          </span>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </p>
  );
}

function Row({ item, kind }: { item: Item; kind: keyof typeof KINDS }) {
  const k = KINDS[kind];
  return (
    <li className="flex flex-col gap-1 rounded-md border border-black/5 bg-white/40 p-2.5 dark:border-white/10 dark:bg-white/5">
      <div className="flex items-center justify-between gap-2">
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${k.className}`}
        >
          {k.label}
        </span>
        <span className="min-w-0 truncate text-[11px] text-muted">
          {item.authorName ?? (item.author ? "Collaborator" : "Nae")} ·{" "}
          {relativeTime(item.at)}
        </span>
      </div>
      {item.diff && item.diff.length > 0 ? (
        <DiffText parts={item.diff} />
      ) : item.markdown ? (
        // The block as written — headings, lists, tables, marks — kept to a
        // compact excerpt; a long block fades out rather than filling the panel.
        // The gradient is pinned to the 7rem cap, so only a block that
        // actually overflows fades; shorter ones stay fully opaque.
        <div className="max-h-28 overflow-hidden [mask-image:linear-gradient(to_bottom,black_5.5rem,transparent_7rem)]">
          <Markdown className="prose-headings:my-0 prose-headings:text-sm prose-p:my-0 prose-ul:my-0 prose-ol:my-0 prose-li:my-0 prose-table:my-0">
            {item.markdown}
          </Markdown>
        </div>
      ) : (
        <p className="line-clamp-2 break-words text-sm text-black/70 dark:text-white/70">
          {item.preview || <span className="italic opacity-60">({item.type})</span>}
        </p>
      )}
    </li>
  );
}

export function DiffPanel({ documentId }: { documentId: Id<"documents"> }) {
  // Each collaborator gets their own watermark — visits is keyed
  // (documentId, userId), so this must be the caller's own Clerk id, not a
  // shared "nae" literal (that would collapse everyone onto one watermark).
  const { userId } = useAuth();
  const diff = useQuery(
    api.diff.diffSince,
    userId ? { documentId, userId } : "skip",
  );
  const markVisited = useMutation(api.diff.markVisited);
  const [marking, setMarking] = useState(false);

  const total = diff
    ? diff.added.length + diff.edited.length + diff.deleted.length
    : 0;

  const caughtUp = async () => {
    if (!userId) return;
    setMarking(true);
    try {
      await markVisited({ documentId, userId });
    } finally {
      setMarking(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex items-center justify-between border-b border-black/10 px-4 py-3 dark:border-white/10">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Since you last looked</h2>
          {total > 0 && (
            <span className="rounded-full bg-foreground px-1.5 py-0.5 text-[11px] font-medium text-background">
              {total}
            </span>
          )}
        </div>
        <button
          onClick={caughtUp}
          disabled={marking}
          className="text-xs font-medium text-muted underline-offset-2 hover:underline disabled:opacity-50"
        >
          {marking ? "…" : "Mark caught up"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {diff === undefined ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : !diff.hasWatermark ? (
          // Momentary: opening the document sets the baseline (ensureVisited).
          <p className="text-sm text-muted">
            Anything added, edited, or deleted from now on shows up here.
          </p>
        ) : total === 0 ? (
          <p className="text-sm text-muted">
            You&apos;re all caught up — nothing has changed since.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {diff.added.map((i) => (
              <Row key={`a-${i.blockId}`} item={i} kind="added" />
            ))}
            {diff.edited.map((i) => (
              <Row key={`e-${i.blockId}`} item={i} kind="edited" />
            ))}
            {diff.deleted.map((i) => (
              <Row key={`d-${i.blockId}`} item={i} kind="deleted" />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
