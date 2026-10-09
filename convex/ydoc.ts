import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import * as Y from "yjs";
import { resolveAccess } from "./access";

/**
 * SuperDoc persistence: a document's Y.Doc lives here as an append-only log
 * of Yjs updates (`ydocUpdates`), written and read by the Convex provider
 * adapter in SuperDoc's collaboration worker (src/superdoc/convexProvider.ts).
 *
 * Sync protocol, per open editor:
 *   1. claimRoom → "create" (you seed it) | "join" | "wait" (retry shortly).
 *   2. Subscribe to `head` — a tiny marker that changes on every write.
 *   3. When it changes, fetch `since(after)` — only the rows you're missing —
 *      and apply them. Yjs updates are idempotent, so overlap is harmless;
 *      the client deliberately re-reads a small window to stay safe.
 *   4. Push local updates with `push`.
 * Subscribing to the full log instead would re-send the whole document on
 * every keystroke batch, to every open tab.
 *
 * Compaction merges a run of update rows into one snapshot row once enough
 * pile up, so opening a document never means replaying thousands of rows.
 *
 * Every function takes an optional `space`: unset is SuperDoc's Y.Doc,
 * "blocknote" is BlockNote's (src/components/BlockNoteEditor.tsx). The two
 * never mix — a document moving to BlockNote keeps its SuperDoc rows intact.
 */

/** Update rows since the last compaction before another is scheduled. */
export const COMPACT_AT = 100;
/** Largest single update `push` accepts — a Convex value caps at 1 MiB. */
export const MAX_UPDATE_BYTES = 900_000;
/** Snapshots larger than this go to file storage instead of an inline row. */
export const INLINE_SNAPSHOT_MAX_BYTES = 800_000;
/** A "create" claim whose tab never wrote anything is abandoned after this. */
export const STALE_CLAIM_MS = 60_000;

export type Space = "blocknote" | undefined;
export const spaceArg = v.optional(v.literal("blocknote"));

export const roomFor = (ctx: QueryCtx | MutationCtx, documentId: Id<"documents">, space: Space) =>
  ctx.db
    .query("ydocRooms")
    .withIndex("by_document_and_space", (q) => q.eq("documentId", documentId).eq("space", space))
    .unique();

const updatesIn = (ctx: QueryCtx | MutationCtx, documentId: Id<"documents">, space: Space) =>
  ctx.db
    .query("ydocUpdates")
    .withIndex("by_document_and_space", (q) => q.eq("documentId", documentId).eq("space", space));

export const hasAnyUpdate = async (
  ctx: QueryCtx | MutationCtx,
  documentId: Id<"documents">,
  space: Space,
) => (await updatesIn(ctx, documentId, space).first()) !== null;

/** Writing to a space the document has moved off would put edits where no
 *  editor reads them. SuperDoc's space is closed once a document is on
 *  BlockNote (a stale tab); BlockNote's is open while a SuperDoc document
 *  converts and after. */
const assertWritable = (editor: "superdoc" | "blocknote" | undefined, space: Space) => {
  const ok = space === "blocknote" ? editor === "superdoc" || editor === "blocknote" : editor !== "blocknote";
  if (!ok) throw new ConvexError({ code: "EDITOR_MISMATCH" });
};

/**
 * Decide, atomically, whether the caller creates this document's room or
 * joins it. SuperDoc refuses to "create" a room that exists and can't "join"
 * one with no content, so this can't be a guess from a query result — two tabs
 * opening a brand-new document at once would both guess "create".
 *   - no room row           → claim it, "create"
 *   - room has content      → "join"
 *   - claimed by this same editor (`claimToken`), still empty → "create" again
 *                             (the editor remounted before writing anything)
 *   - claimed elsewhere, still empty → "wait" (the claimer is seeding it),
 *                             unless the claim is stale — then take it over
 */
export const claimRoom = mutation({
  args: { documentId: v.id("documents"), claimToken: v.string(), space: spaceArg },
  handler: async (ctx, { documentId, claimToken, space }): Promise<"create" | "join" | "wait"> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access) throw new Error("Not found");
    assertWritable(access.doc.editor, space);

    const now = Date.now();
    const room = await roomFor(ctx, documentId, space);
    if (!room) {
      await ctx.db.insert("ydocRooms", {
        documentId,
        claimedBy: identity.subject,
        claimToken,
        claimedAt: now,
        pendingUpdates: 0,
        compactionScheduled: false,
        ...(space ? { space } : {}),
      });
      return "create";
    }
    if (await hasAnyUpdate(ctx, documentId, space)) return "join";
    if (room.claimToken === claimToken) return "create";
    if (now - room.claimedAt < STALE_CLAIM_MS) return "wait";
    await ctx.db.patch(room._id, { claimedBy: identity.subject, claimToken, claimedAt: now });
    return "create";
  },
});

/** A small marker that changes on every write — what clients subscribe to.
 *  `count` is there so a row that commits with an *older* timestamp than the
 *  newest (which wouldn't move `latest`) still wakes subscribers. Compaction
 *  keeps the row count small, so counting is cheap. Null for no access. */
export const head = query({
  args: { documentId: v.id("documents"), space: spaceArg },
  handler: async (ctx, { documentId, space }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    if (!(await resolveAccess(ctx, documentId, identity))) return null;
    const rows = await updatesIn(ctx, documentId, space).collect();
    return {
      latest: rows.length ? Math.max(...rows.map((r) => r._creationTime)) : null,
      count: rows.length,
    };
  },
});

/** Rows created after `after` (a _creationTime), oldest first. A snapshot
 *  held in file storage comes back as a URL for the client to fetch. */
export const since = query({
  args: { documentId: v.id("documents"), after: v.number(), space: spaceArg },
  handler: async (ctx, { documentId, after, space }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    if (!(await resolveAccess(ctx, documentId, identity))) return null;
    const rows = await ctx.db
      .query("ydocUpdates")
      .withIndex("by_document_and_space", (q) =>
        q.eq("documentId", documentId).eq("space", space).gt("_creationTime", after),
      )
      .collect();
    return await Promise.all(
      rows.map(async (r) => ({
        id: r._id,
        createdAt: r._creationTime,
        update: r.update ?? null,
        url: r.storageId ? await ctx.storage.getUrl(r.storageId) : null,
      })),
    );
  },
});

/** Append one (possibly merged) Yjs update from an editor. */
export const push = mutation({
  args: { documentId: v.id("documents"), update: v.bytes(), space: spaceArg },
  handler: async (ctx, { documentId, update, space }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access) throw new Error("Not found");
    assertWritable(access.doc.editor, space);
    if (update.byteLength > MAX_UPDATE_BYTES) {
      // ConvexError, not Error: prod redacts plain messages, and the client
      // needs to know a retry can't help.
      throw new ConvexError({ code: "UPDATE_TOO_LARGE", bytes: update.byteLength });
    }
    const room = await roomFor(ctx, documentId, space);
    if (!room) throw new ConvexError({ code: "NO_ROOM" });

    await ctx.db.insert("ydocUpdates", {
      documentId,
      update,
      author: identity.subject,
      ...(space ? { space } : {}),
    });

    const pendingUpdates = room.pendingUpdates + 1;
    const compact = pendingUpdates >= COMPACT_AT && !room.compactionScheduled;
    await ctx.db.patch(room._id, {
      pendingUpdates,
      ...(compact ? { compactionScheduled: true } : {}),
    });
    if (compact) await ctx.scheduler.runAfter(0, internal.ydoc.compact, { documentId, space });
  },
});

// --- compaction (internal) ---

export const loadForCompaction = internalQuery({
  args: { documentId: v.id("documents"), space: spaceArg },
  handler: async (ctx, { documentId, space }) => {
    const rows = await updatesIn(ctx, documentId, space).collect();
    return rows.map((r) => ({
      id: r._id,
      update: r.update ?? null,
      storageId: r.storageId ?? null,
    }));
  },
});

/**
 * Merge every current row into one snapshot. Uses Y.mergeUpdates, which is
 * lossless — not a GC'd re-encode — because SuperDoc may rely on deleted
 * content (history, tracked changes) that garbage collection would drop.
 * Rows pushed while this runs aren't in `replaced`, so they survive untouched.
 */
export const compact = internalAction({
  args: { documentId: v.id("documents"), space: spaceArg },
  handler: async (ctx, { documentId, space }) => {
    const rows = await ctx.runQuery(internal.ydoc.loadForCompaction, { documentId, space });
    if (rows.length < 2) {
      await ctx.runMutation(internal.ydoc.commitCompaction, { documentId, space, replaced: [] });
      return;
    }
    const parts: Uint8Array[] = [];
    for (const r of rows) {
      if (r.update) {
        parts.push(new Uint8Array(r.update));
      } else if (r.storageId) {
        const blob = await ctx.storage.get(r.storageId);
        if (!blob) throw new Error(`Snapshot blob missing for ${documentId}`);
        parts.push(new Uint8Array(await blob.arrayBuffer()));
      }
    }
    const merged = Y.mergeUpdates(parts);
    const bytes = merged.buffer.slice(
      merged.byteOffset,
      merged.byteOffset + merged.byteLength,
    ) as ArrayBuffer;

    if (bytes.byteLength > INLINE_SNAPSHOT_MAX_BYTES) {
      const storageId = await ctx.storage.store(new Blob([bytes]));
      await ctx.runMutation(internal.ydoc.commitCompaction, {
        documentId,
        space,
        replaced: rows.map((r) => r.id),
        storageId,
      });
    } else {
      await ctx.runMutation(internal.ydoc.commitCompaction, {
        documentId,
        space,
        replaced: rows.map((r) => r.id),
        update: bytes,
      });
    }
  },
});

export const commitCompaction = internalMutation({
  args: {
    documentId: v.id("documents"),
    space: spaceArg,
    replaced: v.array(v.id("ydocUpdates")),
    update: v.optional(v.bytes()),
    storageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, { documentId, space, replaced, update, storageId }) => {
    const room = await roomFor(ctx, documentId, space);
    if (!room) {
      // Document purged mid-compaction — don't leave an orphaned blob.
      if (storageId) await ctx.storage.delete(storageId);
      return;
    }
    if (replaced.length > 0) {
      // Insert first, then delete: a reader between the two can only see
      // duplicate content, which Yjs ignores — never missing content.
      await ctx.db.insert("ydocUpdates", {
        documentId,
        author: "compaction",
        ...(update ? { update } : {}),
        ...(storageId ? { storageId } : {}),
        ...(space ? { space } : {}),
      });
      for (const id of replaced) {
        const row = await ctx.db.get(id);
        if (!row) continue;
        if (row.storageId) await ctx.storage.delete(row.storageId);
        await ctx.db.delete(id);
      }
    }
    const remaining = await updatesIn(ctx, documentId, space).collect();
    await ctx.db.patch(room._id, {
      pendingUpdates: remaining.filter((r) => r.author !== "compaction").length,
      compactionScheduled: false,
    });
  },
});

/** Hard-delete a document's room and every update/snapshot (and blob) in one
 *  space — or, with `space: "all"`, in every space (documents.purgeDeleted's
 *  cascade). */
export async function deleteRoomData(
  ctx: MutationCtx,
  documentId: Id<"documents">,
  space: Space | "all" = undefined,
) {
  const rows =
    space === "all"
      ? await ctx.db
          .query("ydocUpdates")
          .withIndex("by_document", (q) => q.eq("documentId", documentId))
          .collect()
      : await updatesIn(ctx, documentId, space).collect();
  for (const r of rows) {
    if (r.storageId) await ctx.storage.delete(r.storageId);
    await ctx.db.delete(r._id);
  }
  const rooms =
    space === "all"
      ? await ctx.db
          .query("ydocRooms")
          .withIndex("by_document", (q) => q.eq("documentId", documentId))
          .collect()
      : [await roomFor(ctx, documentId, space)];
  for (const room of rooms) if (room) await ctx.db.delete(room._id);
}
