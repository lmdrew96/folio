import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * v1 continuity layer. The in-app Claude's reactions are persisted per document
 * so each new reaction can be threaded the previous ones — the sibling returns
 * to the same writing with memory of its own takes, instead of cold-reading a
 * diff every time. Read path (`recent`) feeds both the prompt and the UI history.
 */

/** Record one reaction the sibling just streamed. Owner-gated like everything else. */
export const record = mutation({
  args: {
    documentId: v.id("documents"),
    content: v.string(),
    summary: v.string(),
  },
  handler: async (ctx, { documentId, content, summary }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.ownerId !== identity.subject) throw new Error("Not found");

    // Don't persist empty/whitespace-only reactions (e.g. a stream that errored
    // out before producing text) — they'd pollute the continuity history.
    if (content.trim().length === 0) return null;

    return await ctx.db.insert("reactions", {
      documentId,
      content,
      summary,
      createdAt: Date.now(),
    });
  },
});

/** Most-recent reactions for a document, newest first. Reactive; owner-gated. */
export const recent = query({
  args: { documentId: v.id("documents"), limit: v.optional(v.number()) },
  handler: async (ctx, { documentId, limit }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.ownerId !== identity.subject) return [];

    const rows = await ctx.db
      .query("reactions")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();

    return rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit ?? 20)
      .map((r) => ({
        id: r._id,
        content: r.content,
        summary: r.summary,
        createdAt: r.createdAt,
      }));
  },
});
