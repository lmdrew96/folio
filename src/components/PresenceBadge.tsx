"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

const HEARTBEAT_MS = 15_000;
// A little over 2x the heartbeat interval — survives one missed beat (a slow
// network tick) without flashing someone's badge off and back on.
const STALE_AFTER_MS = 35_000;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase() || "?";
}

/** Who else is looking at this document right now — a small stack of avatar
 *  circles in the header. Sends its own heartbeat while mounted and clears
 *  itself on unmount; see convex/presence.ts for the staleness model. */
export function PresenceBadge({ documentId }: { documentId: Id<"documents"> }) {
  const { userId } = useAuth();
  const heartbeat = useMutation(api.presence.heartbeat);
  const leave = useMutation(api.presence.leave);
  const rows = useQuery(api.presence.list, { documentId });

  // Forces a re-render every few seconds so a row that's gone stale (no new
  // write, so no fresh query push) still fades out on schedule.
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // The `title` tooltip that reveals names never fires on touch — tapping
  // the stack opens the same names as a small list instead.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    void heartbeat({ documentId });
    const beatId = setInterval(() => void heartbeat({ documentId }), HEARTBEAT_MS);
    const tickId = setInterval(() => setNow(Date.now()), 5_000);
    return () => {
      clearInterval(beatId);
      clearInterval(tickId);
      void leave({ documentId });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  if (!rows) return null;

  const others = rows.filter(
    (r) => r.userId !== userId && now - r.lastSeenAt < STALE_AFTER_MS,
  );
  if (others.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Also viewing this document: ${others.map((r) => r.displayName).join(", ")}`}
        className="flex items-center -space-x-2"
      >
        {others.map((r) => (
          <span
            key={r.userId}
            title={r.displayName}
            className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-[var(--folio-backdrop)] bg-[var(--folio-attr-nae)] text-[11px] font-medium text-white"
          >
            {initials(r.displayName)}
          </span>
        ))}
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-30 flex flex-col gap-1 whitespace-nowrap rounded-lg border border-foreground/10 bg-[var(--folio-paper)] px-3 py-2 text-sm text-foreground/80 shadow-md">
          {others.map((r) => (
            <span key={r.userId}>{r.displayName}</span>
          ))}
        </div>
      )}
    </div>
  );
}
