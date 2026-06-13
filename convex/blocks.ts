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

// --- reconciliation helpers (module-private) ---

/** Order-independent deep equality. ProseMirror node JSON round-tripped through
 *  Convex may come back with reordered object keys, so JSON.stringify isn't safe. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * Assign a sort order to each desired block, in document order, reusing each
 * block's existing order whenever it's still strictly increasing. New blocks
 * (and blocks a reorder pushed out of monotonic order) get a fresh value:
 * midpoint between neighbors for an insert, or prev±1 at the ends. This avoids
 * renumbering every row when a single block is inserted — only the genuinely
 * moved/new rows get a new order. (Float precision drift on deep repeated
 * mid-inserts is a v1 "rebalance on load" concern, not v0.)
 */
function computeOrders(
  blocks: { blockId: string }[],
  existingByBlockId: Map<string, { order: number }>,
): number[] {
  const n = blocks.length;
  const orders = new Array<number>(n);
  let prev: number | null = null;

  for (let i = 0; i < n; i++) {
    const existing = existingByBlockId.get(blocks[i].blockId);
    if (existing !== undefined && (prev === null || existing.order > prev)) {
      orders[i] = existing.order;
      prev = existing.order;
      continue;
    }
    // Find the next block we'll be able to keep, to bound the new value above.
    let upper: number | null = null;
    for (let j = i + 1; j < n; j++) {
      const ej = existingByBlockId.get(blocks[j].blockId);
      if (ej !== undefined && (prev === null || ej.order > prev)) {
        upper = ej.order;
        break;
      }
    }
    let next: number;
    if (prev === null && upper === null) next = 0;
    else if (prev === null) next = upper! - 1;
    else if (upper === null) next = prev + 1;
    else next = (prev + upper) / 2;
    orders[i] = next;
    prev = next;
  }
  return orders;
}

/**
 * THE keystone. Reconcile the editor's top-level nodes against the doc's Convex
 * block rows in a single atomic mutation:
 *   - new blockId            → insert
 *   - existing, content/type changed → patch content + bump lastEditedAt
 *   - existing, order changed only   → patch order (NO lastEditedAt bump)
 *   - row whose blockId vanished     → delete
 * Idempotent: re-running with the same desired state writes nothing.
 *
 * `actor` is hardcoded "nae" here; Patch 3 threads the real actor param and
 * builds the attribution UI. Deletes are hard for now; Patch 4 soft-deletes.
 */
export const reconcile = mutation({
  args: {
    documentId: v.id("documents"),
    // Desired top-level blocks, in document order (array index = position).
    blocks: v.array(
      v.object({
        blockId: v.string(),
        type: v.string(),
        content: v.any(),
      }),
    ),
  },
  handler: async (ctx, { documentId, blocks }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.ownerId !== identity.subject) throw new Error("Not found");

    const existingRows = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();
    const existingByBlockId = new Map(existingRows.map((r) => [r.blockId, r]));

    const orders = computeOrders(blocks, existingByBlockId);
    const desiredIds = new Set(blocks.map((b) => b.blockId));
    const now = Date.now();
    let changed = false;

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const order = orders[i];
      const existing = existingByBlockId.get(b.blockId);

      if (existing === undefined) {
        await ctx.db.insert("blocks", {
          documentId,
          blockId: b.blockId,
          order,
          type: b.type,
          content: b.content,
          author: "nae", // Patch 3 threads the real actor
          createdAt: now,
          lastEditedAt: now,
        });
        changed = true;
        continue;
      }

      const contentChanged =
        existing.type !== b.type || !deepEqual(existing.content, b.content);
      const orderChanged = existing.order !== order;
      if (!contentChanged && !orderChanged) continue;

      const patch: Record<string, unknown> = {};
      if (existing.type !== b.type) patch.type = b.type;
      if (contentChanged) {
        patch.content = b.content;
        patch.lastEditedAt = now; // an actual edit (Patch 3 also sets author here)
      }
      if (orderChanged) patch.order = order; // reordering is not editing — no bump
      await ctx.db.patch(existing._id, patch);
      changed = true;
    }

    for (const row of existingRows) {
      if (!desiredIds.has(row.blockId)) {
        await ctx.db.delete(row._id);
        changed = true;
      }
    }

    if (changed) await ctx.db.patch(documentId, { updatedAt: now });
  },
});
