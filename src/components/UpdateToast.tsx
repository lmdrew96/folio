"use client";

import { useState } from "react";
import { useAppVersion, useChunkErrorRecovery } from "@/lib/useAppVersion";
import { flushPendingSaves } from "@/lib/pendingSave";

/**
 * "A newer Folio is ready" — a dismissible prompt, never an auto-reload.
 *
 * Placement is deliberate: bottom-left, above the word-count/outline row.
 * That keeps it clear of the editor toolbar (top of the column), the
 * changes/Cleo sidebar (right at lg, a drawer below it), and the save pill
 * (bottom centre) at every breakpoint. `.fixed` is hidden in print, so it
 * never reaches paper.
 */
export function UpdateToast() {
  const { updateReady, dismiss } = useAppVersion();
  const [phase, setPhase] = useState<"idle" | "saving" | "unsaved">("idle");

  // Lives here rather than in its own component: both halves are the same
  // concern — this tab is running a build that no longer exists on the server.
  useChunkErrorRecovery();

  if (!updateReady) return null;

  const refresh = async () => {
    setPhase("saving");
    // Save first, then reload — a reload over an in-flight block save would
    // lose whatever the debounce hadn't sent yet.
    if (await flushPendingSaves()) {
      window.location.reload();
      return;
    }
    // Couldn't confirm the save. Say so instead of quietly discarding it.
    setPhase("unsaved");
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-16 left-5 z-40 w-[min(20rem,calc(100vw-2.5rem))] rounded-lg border border-foreground/10 bg-[var(--folio-paper)] p-4 shadow-md"
    >
      <p className="text-sm font-medium text-foreground">
        {phase === "unsaved" ? "Couldn’t save your latest edit" : "A newer Folio is ready"}
      </p>
      <p className="mt-0.5 text-xs text-foreground/60">
        {phase === "unsaved"
          ? "Refreshing now would lose it. Check your connection, or refresh anyway."
          : "This tab is running an older version. Your work is saved first."}
      </p>
      <div className="mt-3 flex gap-2">
        <button
          onClick={
            phase === "unsaved" ? () => window.location.reload() : () => void refresh()
          }
          disabled={phase === "saving"}
          className="rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {phase === "saving"
            ? "Saving…"
            : phase === "unsaved"
              ? "Refresh anyway"
              : "Refresh"}
        </button>
        <button
          onClick={dismiss}
          className="rounded-full px-3 py-1.5 text-xs font-medium text-foreground/60 transition hover:bg-black/5 dark:hover:bg-white/10"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
