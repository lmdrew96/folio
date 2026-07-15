import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";

// How long a soft-deleted document stays recoverable before the daily purge
// cron (convex/crons.ts) hard-deletes it and cascades to its children.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
      .filter((d) => d.deletedAt === undefined)
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
    if (!doc || doc.ownerId !== identity.subject || doc.deletedAt !== undefined) {
      return null;
    }
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
 * Soft-delete a document the caller owns — sets a tombstone instead of an
 * immediate hard delete, so the client can offer an "Undo" toast. Blocks,
 * visits, and reactions are left untouched (restorable via `restore`); the
 * daily purge cron (convex/crons.ts → purgeDeleted below) hard-deletes the
 * document and cascades to its children once the tombstone outlives the
 * retention window.
 */
export const remove = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.ownerId !== identity.subject) throw new Error("Not found");

    await ctx.db.patch(documentId, { deletedAt: Date.now() });
  },
});

/** Undo a pending delete — clears the tombstone so the document reappears. */
export const restore = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.ownerId !== identity.subject) throw new Error("Not found");
    if (doc.deletedAt === undefined) return; // nothing pending — no-op

    await ctx.db.patch(documentId, { deletedAt: undefined, updatedAt: Date.now() });
  },
});

/**
 * Hard-delete documents whose soft-delete tombstone is older than the
 * retention window, cascading to their blocks/visits/reactions/messages.
 * Called only by the daily cron in convex/crons.ts — never exposed to the
 * client, so a restore is impossible to race once this runs.
 */
export const purgeDeleted = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - RETENTION_MS;
    // Personal-scale table (one owner in practice) — a full scan here mirrors
    // the same collect-then-filter pattern blocks.ts already uses for its own
    // soft-delete tombstones.
    const docs = await ctx.db.query("documents").collect();

    for (const doc of docs) {
      if (doc.deletedAt === undefined || doc.deletedAt > cutoff) continue;

      const [blocks, visits, reactions, messages] = await Promise.all([
        ctx.db
          .query("blocks")
          .withIndex("by_document", (q) => q.eq("documentId", doc._id))
          .collect(),
        ctx.db
          .query("visits")
          .withIndex("by_doc_user", (q) => q.eq("documentId", doc._id))
          .collect(),
        ctx.db
          .query("reactions")
          .withIndex("by_document", (q) => q.eq("documentId", doc._id))
          .collect(),
        ctx.db
          .query("messages")
          .withIndex("by_document", (q) => q.eq("documentId", doc._id))
          .collect(),
      ]);

      await Promise.all([
        ...blocks.map((b) => ctx.db.delete(b._id)),
        ...visits.map((visit) => ctx.db.delete(visit._id)),
        ...reactions.map((r) => ctx.db.delete(r._id)),
        ...messages.map((m) => ctx.db.delete(m._id)),
        ctx.db.delete(doc._id),
      ]);
    }
  },
});
