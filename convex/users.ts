import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { resolveFriendsForEmail } from "./friends";

/**
 * Durable profile sync — called once client-side on every sign-in (see
 * src/components/UserSync.tsx), mirroring Cha(t)os's users.ts. Exists so
 * Folio never has to depend on what Clerk's "convex" JWT template happens to
 * carry: the client already has verified email/name via Clerk's own
 * useUser(), so we just upsert it here.
 *
 * Doing double duty: the same write resolves any pending document invites
 * for this email — no separate "accept" step, no webhook.
 */
export const upsertUser = mutation({
  args: { email: v.string(), displayName: v.string() },
  handler: async (ctx, { email, displayName }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const normalizedEmail = email.trim().toLowerCase();

    const existing = await ctx.db
      .query("users")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { email: normalizedEmail, displayName });
    } else {
      await ctx.db.insert("users", {
        userId: identity.subject,
        email: normalizedEmail,
        displayName,
      });
    }

    const pendingShares = await ctx.db
      .query("documentShares")
      .withIndex("by_email", (q) => q.eq("invitedEmail", normalizedEmail))
      .collect();
    const now = Date.now();
    for (const share of pendingShares) {
      if (share.userId !== undefined) continue; // already resolved
      await ctx.db.patch(share._id, {
        userId: identity.subject,
        acceptedAt: now,
        displayName,
      });
    }

    await resolveFriendsForEmail(ctx, normalizedEmail, identity.subject, displayName);
  },
});
