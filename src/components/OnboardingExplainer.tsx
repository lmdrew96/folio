"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { folioClaudeLabel } from "@/lib/identity";

const SEEN_KEY = "folio:onboarding:collaboratorExplainerSeen";

/** A light, one-time explainer for a freshly-invited collaborator — the diff
 *  panel + Cleo sidebar otherwise land with zero context the first time
 *  someone opens a doc that's been shared with them. Shown once, ever,
 *  across the whole app (not per-document — re-showing on every newly
 *  shared doc would cut against calm-by-default), then gone for good. */
export function OnboardingExplainer({ documentId }: { documentId: Id<"documents"> }) {
  const doc = useQuery(api.documents.get, { documentId });
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SEEN_KEY) === "true";
  });

  if (dismissed || doc?.role !== "editor") return null;

  const dismiss = () => {
    window.localStorage.setItem(SEEN_KEY, "true");
    setDismissed(true);
  };

  return (
    <div className="m-2 flex shrink-0 flex-col gap-1.5 rounded-lg border border-foreground/10 bg-[var(--folio-paper)] p-3 text-xs text-foreground/70 shadow-sm">
      <p>
        <strong className="font-medium text-foreground">Changes</strong> shows
        what&rsquo;s new since you last looked here; {folioClaudeLabel()} can
        help you catch up on a document.
      </p>
      <button
        type="button"
        onClick={dismiss}
        className="self-start text-foreground/50 underline-offset-2 hover:text-foreground hover:underline"
      >
        Got it
      </button>
    </div>
  );
}
