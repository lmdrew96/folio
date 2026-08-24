"use client";

import { useEffect, useState } from "react";
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
  const friends = useQuery(api.friends.list) ?? [];
  const invite = useMutation(api.documents.invite);
  const revokeShare = useMutation(api.documents.revokeShare);

  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const doInvite = async (targetEmail: string) => {
    const trimmed = targetEmail.trim();
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

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void doInvite(email);
  };

  // Friends already on this doc don't need to show up as suggestions again.
  const invitedEmails = new Set((collaborators ?? []).map((c) => c.invitedEmail));
  const query = email.trim().toLowerCase();
  const available = friends.filter((f) => !invitedEmails.has(f.email));
  // Empty query + focused shows a few saved friends up front — "share with
  // someone I've already shared with" becomes a zero-typing action.
  const matches =
    query.length > 0
      ? available.filter(
          (f) => f.email.includes(query) || f.displayName?.toLowerCase().includes(query),
        )
      : focused
        ? available.slice(0, 5)
        : [];

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
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
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

        {matches.length > 0 && (
          <ul className="-mt-2 flex flex-col gap-1">
            {matches.map((f) => (
              <li key={f._id}>
                <button
                  type="button"
                  disabled={sending}
                  // Preserve the click across the input's blur (which fires
                  // first and would otherwise hide this list before the
                  // click registers).
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void doInvite(f.email)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-foreground/80 transition hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/10"
                >
                  <span className="min-w-0 truncate">{f.displayName ?? f.email}</span>
                  {f.displayName && (
                    <span className="shrink-0 truncate text-xs text-foreground/40">
                      {f.email}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

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
