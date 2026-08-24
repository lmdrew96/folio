import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { UserIdentity } from "convex/server";

export type Access = { doc: Doc<"documents">; role: "owner" | "editor" };

/**
 * Owner or accepted-share access to a document — the one check every
 * documents/blocks/diff/messages function gates on. Returns null for
 * "not found" and "found but no access" alike, mirroring the pre-sharing
 * ownerId-only checks this replaces (never leaks whether a document exists).
 */
export async function resolveAccess(
  ctx: QueryCtx | MutationCtx,
  documentId: Id<"documents">,
  identity: UserIdentity,
): Promise<Access | null> {
  const doc = await ctx.db.get(documentId);
  if (!doc || doc.deletedAt !== undefined) return null;
  if (doc.ownerId === identity.subject) return { doc, role: "owner" };

  // collect(), not unique() — the same person can end up with two share rows
  // if they were invited at two different emails before signing up (invite
  // dedupes per-email, not per-person), so more than one row can legitimately
  // match this userId.
  const shares = await ctx.db
    .query("documentShares")
    .withIndex("by_document_and_user", (q) =>
      q.eq("documentId", documentId).eq("userId", identity.subject),
    )
    .collect();
  if (shares.some((s) => s.acceptedAt !== undefined)) return { doc, role: "editor" };

  return null;
}
