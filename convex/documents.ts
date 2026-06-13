import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Every document the caller owns, most-recently-edited first. Reactive. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const docs = await ctx.db
      .query("documents")
      .withIndex("by_owner", (q) => q.eq("ownerId", identity.subject))
      .collect();
    // reconcile bumps updatedAt on every edit, so this is a true "recent" order.
    return docs
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((d) => ({
        _id: d._id,
        title: d.title,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      }));
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

/** Create a fresh untitled document and return its id. */
export const create = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const now = Date.now();
    return await ctx.db.insert("documents", {
      ownerId: identity.subject,
      title: "Untitled",
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Rename a document the caller owns. Blank titles fall back to "Untitled". */
export const rename = mutation({
  args: { documentId: v.id("documents"), title: v.string() },
  handler: async (ctx, { documentId, title }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.ownerId !== identity.subject) throw new Error("Not found");

    const trimmed = title.trim();
    await ctx.db.patch(documentId, {
      title: trimmed.length > 0 ? trimmed : "Untitled",
      updatedAt: Date.now(),
    });
  },
});

/**
 * Delete a document the caller owns, plus everything scoped to it — blocks,
 * per-identity visit watermarks, and Claude's reactions. Hard delete: the doc
 * is gone, so the soft-delete tombstones blocks use for diff don't apply here.
 */
export const remove = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.ownerId !== identity.subject) throw new Error("Not found");

    const blocks = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();
    for (const b of blocks) await ctx.db.delete(b._id);

    const visits = await ctx.db
      .query("visits")
      .withIndex("by_doc_user", (q) => q.eq("documentId", documentId))
      .collect();
    for (const visit of visits) await ctx.db.delete(visit._id);

    const reactions = await ctx.db
      .query("reactions")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();
    for (const r of reactions) await ctx.db.delete(r._id);

    await ctx.db.delete(documentId);
  },
});
