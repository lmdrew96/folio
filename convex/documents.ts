import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * v0 has no doc-list UI — a signed-in user gets exactly one document.
 * This mutation returns the caller's document, creating it on first call.
 */
export const getOrCreateDefault = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const ownerId = identity.subject;

    const existing = await ctx.db
      .query("documents")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .first();
    if (existing) return existing._id;

    const now = Date.now();
    return await ctx.db.insert("documents", {
      ownerId,
      title: "Untitled",
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Fetch a document the caller owns (null otherwise). */
export const get = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.ownerId !== identity.subject) return null;
    return doc;
  },
});
