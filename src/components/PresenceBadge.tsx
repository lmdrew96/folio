"use client";

import { useEffect, useState } from "react";
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
    <div className="flex items-center -space-x-2" aria-label="Also viewing this document">
      {others.map((r) => (
        <div
          key={r.userId}
          title={r.displayName}
          className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-[var(--folio-backdrop)] bg-[var(--folio-attr-nae)] text-[11px] font-medium text-white"
        >
          {initials(r.displayName)}
        </div>
      ))}
    </div>
  );
}
