import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** All blocks for a document the caller owns, ordered. Reactive. */
export const list = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.ownerId !== identity.subject) return [];

    const blocks = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();
    return blocks.sort((a, b) => a.order - b.order);
  },
});

/**
 * Patch 1 persistence is deliberately naive: full replace on blur.
 * Wipe the doc's blocks and reinsert from the editor's current top-level nodes.
 *
 * Real reconciliation (upsert-by-blockId, deletes, fractional order, attribution)
 * is Patch 2/3 — this just proves the round-trip persists and reloads.
 */
export const replaceAll = mutation({
  args: {
    documentId: v.id("documents"),
    blocks: v.array(
      v.object({
        blockId: v.string(),
        type: v.string(),
        content: v.any(),
        order: v.number(),
      }),
    ),
  },
  handler: async (ctx, { documentId, blocks }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.ownerId !== identity.subject) throw new Error("Not found");

    const existing = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();
    for (const row of existing) await ctx.db.delete(row._id);

    const now = Date.now();
    for (const b of blocks) {
      await ctx.db.insert("blocks", {
        documentId,
        blockId: b.blockId,
        order: b.order,
        type: b.type,
        content: b.content,
        author: "nae", // placeholder until Patch 3 threads the real actor
        createdAt: now,
        lastEditedAt: now,
      });
    }
    await ctx.db.patch(documentId, { updatedAt: now });
  },
});
