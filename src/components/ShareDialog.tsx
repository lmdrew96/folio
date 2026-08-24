"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

/** Owner-only sharing UI — invite a collaborator by email, see who's on the
 *  document (pending vs accepted), revoke access. */
export function ShareDialog({
  documentId,
  onClose,
}: {
  documentId: Id<"documents">;
  onClose: () => void;
}) {
  const collaborators = useQuery(api.documents.listCollaborators, { documentId });
  const invite = useMutation(api.documents.invite);
  const revokeShare = useMutation(api.documents.revokeShare);

  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setSending(true);
    setError(null);
    try {
      await invite({ documentId, email: trimmed });
      setEmail("");
    } catch (err) {
      console.error("Folio: invite failed", err);
      setError("Couldn't send that invite — try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/30"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Share this document"
        className="folio-card relative flex w-full max-w-sm flex-col gap-4 p-5"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-lg text-foreground">Share</h2>
          <button
            onClick={onClose}
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

        <form onSubmit={submit} className="flex items-center gap-2">
          <label className="sr-only" htmlFor="folio-share-email">
            Email to invite
          </label>
          <input
            id="folio-share-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Their email…"
            className="min-w-0 flex-1 rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-3.5 py-1.5 text-sm text-foreground outline-none transition placeholder:text-foreground/40 focus:ring-2 focus:ring-[var(--folio-attr-sibling)]"
          />
          <button
            type="submit"
            disabled={sending || !email.trim()}
            className="shrink-0 rounded-full bg-foreground px-3.5 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {sending ? "…" : "Invite"}
          </button>
        </form>
        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

        <ul className="flex flex-col gap-2">
          {collaborators === undefined ? (
            <li className="text-sm text-foreground/50">Loading…</li>
          ) : collaborators.length === 0 ? (
            <li className="text-sm text-foreground/50">
              Not shared with anyone yet.
            </li>
          ) : (
            collaborators.map((c) => (
              <li
                key={c._id}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span className="min-w-0 truncate text-foreground/80">
                  {c.displayName ?? c.invitedEmail}
                  {!c.accepted && (
                    <span className="ml-1.5 text-xs text-foreground/40">
                      (pending)
                    </span>
                  )}
                </span>
                <button
                  onClick={() => revokeShare({ documentId, shareId: c._id })}
                  className="shrink-0 text-xs text-foreground/50 underline-offset-2 hover:text-foreground hover:underline"
                >
                  Remove
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
