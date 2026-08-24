"use client";

import { useState } from "react";
import changelog from "@/generated/changelog.json";

const VERSION_RE = /^v(\d+\.\d+\.\d+):\s*(.+)$/;

/** Public — no auth gate, visible from the desk header for signed-in and
 *  signed-out visitors alike. Reads a build-time snapshot (see
 *  scripts/generate-changelog.mjs) rather than hitting git at runtime. */
export function ChangeLog() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-full px-3 py-1.5 text-sm font-medium text-foreground/70 transition hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
      >
        What&apos;s new
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="absolute inset-0 cursor-default bg-black/30"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Recent changes"
            className="folio-card relative flex w-full max-w-sm flex-col gap-4 p-5"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-serif text-lg text-foreground">What&apos;s new</h2>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
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

            <ul className="flex flex-col gap-3">
              {changelog.map((entry) => {
                const match = entry.subject.match(VERSION_RE);
                return (
                  <li key={entry.hash} className="flex items-start gap-3 text-sm">
                    <span className="mt-0.5 shrink-0 text-xs text-foreground/40">
                      {entry.date}
                    </span>
                    <span className="min-w-0 text-foreground/80">
                      {match && (
                        <span className="mr-1.5 rounded-full bg-black/5 px-1.5 py-0.5 text-[11px] font-medium text-foreground/60 dark:bg-white/10">
                          v{match[1]}
                        </span>
                      )}
                      {match ? match[2] : entry.subject}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
