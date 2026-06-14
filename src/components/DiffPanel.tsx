"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { relativeTime } from "@/lib/time";

// v0 tracks one human watermark; Patch 5 adds the "claude" watermark.
const USER = "nae";

type Item = {
  blockId: string;
  type: string;
  preview: string;
  author?: string;
  at: number;
};

const KINDS = {
  added: { label: "Added", className: "bg-[#849440]/15 text-[#5e6a2d]" },
  edited: { label: "Edited", className: "bg-[#DFA649]/20 text-[#8a6512]" },
  deleted: { label: "Deleted", className: "bg-[#88739E]/20 text-[#6b577f]" },
} as const;

function Row({ item, kind }: { item: Item; kind: keyof typeof KINDS }) {
  const k = KINDS[kind];
  return (
    <li className="flex flex-col gap-1 rounded-md border border-black/5 bg-white/40 p-2.5 dark:border-white/10 dark:bg-white/5">
      <div className="flex items-center justify-between gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${k.className}`}
        >
          {k.label}
        </span>
        <span className="text-[11px] text-black/40 dark:text-white/40">
          {item.author ?? "nae"} · {relativeTime(item.at)}
        </span>
      </div>
      <p className="line-clamp-2 text-sm text-black/70 dark:text-white/70">
        {item.preview || <span className="italic opacity-60">({item.type})</span>}
      </p>
    </li>
  );
}

export function DiffPanel({ documentId }: { documentId: Id<"documents"> }) {
  const diff = useQuery(api.diff.diffSince, { documentId, userId: USER });
  const markVisited = useMutation(api.diff.markVisited);
  const [marking, setMarking] = useState(false);

  const total = diff
    ? diff.added.length + diff.edited.length + diff.deleted.length
    : 0;

  const caughtUp = async () => {
    setMarking(true);
    try {
      await markVisited({ documentId, userId: USER });
    } finally {
      setMarking(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
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
          className="text-xs font-medium text-black/60 underline-offset-2 hover:underline disabled:opacity-50 dark:text-white/60"
        >
          {marking ? "…" : "Mark caught up"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {diff === undefined ? (
          <p className="text-sm text-black/40 dark:text-white/40">Loading…</p>
        ) : !diff.hasWatermark ? (
          <p className="text-sm text-black/50 dark:text-white/50">
            Hit <span className="font-medium">Mark caught up</span> to set your
            baseline. After that, anything added, edited, or deleted shows up
            here.
          </p>
        ) : total === 0 ? (
          <p className="text-sm text-black/50 dark:text-white/50">
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
