import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { resolveAccess } from "./access";

// Floor on how long a soft-deleted block's tombstone is kept, regardless of
// watermark state — see purgeOldTombstones below.
const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** All blocks for a document the caller owns or has editor access to,
 *  ordered. Reactive. */
export const list = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access) return [];

    const blocks = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();
    return blocks
      .filter((b) => b.deletedAt === undefined) // hide soft-deleted (Patch 4)
      .sort((a, b) => a.order - b.order);
  },
});

// --- reconciliation helpers (module-private) ---

// Marks/attrs that only change how text looks, not what it says — stripped
// before deciding whether a block's edit is worth surfacing in a diff. A
// document-wide font/size/color pass touches every block's marks/attrs
// without touching a single word, and shouldn't read as hundreds of edits.
const STYLE_MARK_TYPES = new Set(["bold", "italic", "underline", "strike", "textStyle", "highlight"]);
const STYLE_ATTR_KEYS = ["textAlign", "fontSize", "lineHeight", "indent"];

/** Strip purely-visual marks/attrs from a ProseMirror node (recursively), so
 *  comparing two stripped trees only reflects on-page-meaning changes. */
function stripStyle(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripStyle);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "marks" && Array.isArray(value)) {
      const kept = (value as { type?: string }[]).filter(
        (m) => !STYLE_MARK_TYPES.has(m.type ?? ""),
      );
      if (kept.length) out.marks = kept;
      continue;
    }
    if (key === "attrs" && value && typeof value === "object") {
      const attrs = { ...(value as Record<string, unknown>) };
      for (const k of STYLE_ATTR_KEYS) delete attrs[k];
      if (Object.keys(attrs).length) out.attrs = attrs;
      continue;
    }
    out[key] = key === "content" ? stripStyle(value) : value;
  }
  return out;
}

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
 * Attribution (`author`) is derived server-side from the caller's own
 * identity, never accepted as an argument — a collaborator can't forge
 * another person's name on a block they didn't write.
 * Removed blocks are soft-deleted (deletedAt tombstone) so diff-since-visit
 * (Patch 4) can still see them; a returning blockId (undo) is revived.
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
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access) throw new Error("Not found");

    const actor = identity.subject;
    const account = await ctx.db
      .query("users")
      .withIndex("by_user", (q) => q.eq("userId", actor))
      .unique();
    const actorName = account?.displayName;

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
          author: actor,
          authorName: actorName,
          createdAt: now,
          lastEditedAt: now,
        });
        changed = true;
        continue;
      }

      // A soft-deleted block whose id is back (e.g. undo) → revive it.
      if (existing.deletedAt !== undefined) {
        await ctx.db.patch(existing._id, {
          content: b.content,
          type: b.type,
          order,
          author: actor,
          authorName: actorName,
          lastEditedAt: now,
          deletedAt: undefined, // clear the tombstone
        });
        changed = true;
        continue;
      }

      const typeChanged = existing.type !== b.type;
      const contentChanged = typeChanged || !deepEqual(existing.content, b.content);
      const orderChanged = existing.order !== order;
      if (!contentChanged && !orderChanged) continue;

      // Style-only changes (font/size/color/etc.) still update the stored
      // content so rendering stays correct, but don't count as an "edit" for
      // diff/attribution purposes — only a meaning change does.
      const meaningfulChanged =
        typeChanged || !deepEqual(stripStyle(existing.content), stripStyle(b.content));

      const patch: Record<string, unknown> = {};
      if (typeChanged) patch.type = b.type;
      if (contentChanged) {
        patch.content = b.content;
        if (meaningfulChanged) {
          patch.previousContent = existing.content; // for the diff panel's word-level view
          patch.author = actor; // whoever last touched it owns it now
          patch.authorName = actorName;
          patch.lastEditedAt = now;
        }
      }
      if (orderChanged) patch.order = order; // reordering is not editing — no bump
      await ctx.db.patch(existing._id, patch);
      changed = true;
    }

    // Soft-delete rows that left the doc (keep the tombstone so diff can see it).
    for (const row of existingRows) {
      if (!desiredIds.has(row.blockId) && row.deletedAt === undefined) {
        await ctx.db.patch(row._id, { deletedAt: now });
        changed = true;
      }
    }

    if (changed) await ctx.db.patch(documentId, { updatedAt: now });
  },
});

/**
 * Hard-delete soft-deleted block tombstones that are both older than
 * TOMBSTONE_RETENTION_MS and older than every watermark in `visits` for their
 * document. The watermark bound is what makes this safe: diff/reactionPayload
 * only surface a tombstone when `deletedAt > watermark`, so once a tombstone
 * predates every watermark it's already invisible to every diff view — purging
 * it changes nothing but row count. A document with no visits yet has no bound
 * to violate (diffSince returns empty until a first watermark is set, so
 * nothing could ever look back that far). Runs on a weekly cron (convex/crons.ts).
 */
export const purgeOldTombstones = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - TOMBSTONE_RETENTION_MS;
    const documents = await ctx.db.query("documents").collect();

    for (const doc of documents) {
      const tombstones = (
        await ctx.db
          .query("blocks")
          .withIndex("by_document", (q) => q.eq("documentId", doc._id))
          .collect()
      ).filter(
        (b): b is typeof b & { deletedAt: number } =>
          b.deletedAt !== undefined && b.deletedAt < cutoff,
      );
      if (tombstones.length === 0) continue;

      const visits = await ctx.db
        .query("visits")
        .withIndex("by_doc_user", (q) => q.eq("documentId", doc._id))
        .collect();
      const oldestWatermark = visits.length
        ? Math.min(...visits.map((v) => v.lastVisitedAt))
        : Infinity;

      const purgeable = tombstones.filter((b) => b.deletedAt < oldestWatermark);
      await Promise.all(purgeable.map((b) => ctx.db.delete(b._id)));
    }
  },
});
