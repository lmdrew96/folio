import { query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";

/** The caller's saved contacts, most-recently-added first. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const friends = await ctx.db
      .query("friends")
      .withIndex("by_owner", (q) => q.eq("ownerId", identity.subject))
      .collect();
    return friends
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((f) => ({
        _id: f._id,
        email: f.friendEmail,
        displayName: f.friendDisplayName,
      }));
  },
});

/**
 * Remember someone as a contact — no-op if already saved. Called from
 * documents.invite (not exposed as a standalone "add friend" mutation; v1
 * has no friend-request flow, just this rolodex that fills in as you share).
 */
export async function rememberFriend(
  ctx: MutationCtx,
  ownerId: string,
  email: string,
  account: { userId: string; displayName: string } | null,
): Promise<void> {
  const existing = await ctx.db
    .query("friends")
    .withIndex("by_owner_and_email", (q) =>
      q.eq("ownerId", ownerId).eq("friendEmail", email),
    )
    .unique();
  if (existing) return;

  await ctx.db.insert("friends", {
    ownerId,
    friendEmail: email,
    friendUserId: account?.userId,
    friendDisplayName: account?.displayName,
    addedAt: Date.now(),
  });
}

/**
 * Keep every saved contact's resolved name/id current once the person they
 * point at signs up or updates their profile — mirrors how upsertUser
 * resolves pending documentShares for the same email.
 */
export async function resolveFriendsForEmail(
  ctx: MutationCtx,
  email: string,
  userId: string,
  displayName: string,
): Promise<void> {
  const rows = await ctx.db
    .query("friends")
    .withIndex("by_friend_email", (q) => q.eq("friendEmail", email))
    .collect();
  for (const row of rows) {
    await ctx.db.patch(row._id, { friendUserId: userId, friendDisplayName: displayName });
  }
}
