import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { resolveAccess } from "./access";

/**
 * "Who's here right now" for a document. A client-side heartbeat (see
 * PresenceBadge.tsx) upserts a row every ~15s while the document is open;
 * `leave` deletes it on a clean unmount. There's no server-side "are you
 * still there?" push — `list` returns raw rows and the client filters out
 * anything older than its own staleness window, re-checking on a timer so a
 * crashed/closed tab's badge fades even without a new write. `purgeStale`
 * (convex/crons.ts) just keeps the table from growing unbounded.
 */

// Rows older than this are dead weight — well past any client's staleness
// window, so nothing live is ever purged out from under it.
const PURGE_AFTER_MS = 2 * 60 * 1000; // 2 minutes

/** Mark the caller as present on a document — owner or editor only. */
export const heartbeat = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access) throw new Error("Not found");

    const account = await ctx.db
      .query("users")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .unique();
    const displayName = account?.displayName ?? identity.name ?? "Collaborator";

    const existing = await ctx.db
      .query("presence")
      .withIndex("by_doc_user", (q) =>
        q.eq("documentId", documentId).eq("userId", identity.subject),
      )
      .unique();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { displayName, lastSeenAt: now });
    } else {
      await ctx.db.insert("presence", {
        documentId,
        userId: identity.subject,
        displayName,
        lastSeenAt: now,
      });
    }
  },
});

/** Clear the caller's presence row — called on a clean unmount/navigate-away. */
export const leave = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return;

    const existing = await ctx.db
      .query("presence")
      .withIndex("by_doc_user", (q) =>
        q.eq("documentId", documentId).eq("userId", identity.subject),
      )
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

/** Everyone with a recent presence row on a document — owner or editor only.
 *  Includes the caller; the UI filters itself out. Reactive: subscribers
 *  re-render on every heartbeat/leave, but a row that just goes stale (no
 *  write) needs the client's own timer to notice. */
export const list = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access) return [];

    const rows = await ctx.db
      .query("presence")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();

    return rows.map((r) => ({
      userId: r.userId,
      displayName: r.displayName,
      lastSeenAt: r.lastSeenAt,
    }));
  },
});

/** Drop presence rows nobody's heartbeat has touched in a while. Called only
 *  by the cron in convex/crons.ts. */
export const purgeStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - PURGE_AFTER_MS;
    // Personal-scale table — same collect-then-filter shape as the other
    // purge crons in this codebase.
    const rows = await ctx.db.query("presence").collect();
    await Promise.all(
      rows.filter((r) => r.lastSeenAt < cutoff).map((r) => ctx.db.delete(r._id)),
    );
  },
});
