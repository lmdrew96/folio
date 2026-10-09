import { internalMutation, internalQuery, mutation, type MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { resolveAccess } from "./access";
import { deleteRoomData, hasAnyUpdate, roomFor } from "./ydoc";
import { MAX_BLOCK_CONTENT_BYTES } from "./blockContent";

/**
 * Converting a TipTap document to SuperDoc (migration phase 4).
 *
 * The conversion itself runs in the browser — only SuperDoc can build its
 * Y.Doc — inside the SuperDoc editor that then simply stays open:
 *   1. `prepare` clears a room left behind by a conversion that never finished.
 *   2. The editor claims the room, imports the TipTap content, and checks the
 *      imported text against the original, block by block.
 *   3. `finish` switches the document over in one transaction, or `fail`
 *      records why it couldn't and the document stays on TipTap.
 * `revert` (internal, run by hand) puts a converted document back.
 */

/** A room this old on an unconverted document is a conversion that died. */
export const STALE_CONVERSION_MS = 2 * 60_000;

/** Block types whose one row becomes one SuperDoc block, so the "before"
 *  text the diff panel shows still lines up with the converted block. */
const ONE_TO_ONE_TYPES = new Set(["paragraph", "heading"]);

/** The SuperDoc room — the one a TipTap document converts into. */
const roomOf = (ctx: MutationCtx, documentId: Id<"documents">) => roomFor(ctx, documentId, undefined);

async function editableDoc(ctx: MutationCtx, documentId: Id<"documents">): Promise<Doc<"documents">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  const access = await resolveAccess(ctx, documentId, identity);
  if (!access) throw new Error("Not found");
  return access.doc;
}

/**
 * Before converting: may this editor start? "ready" also covers this same
 * editor re-preparing after a remount (`claimToken` matches its own room).
 */
export const prepare = mutation({
  args: { documentId: v.id("documents"), claimToken: v.string() },
  handler: async (ctx, { documentId, claimToken }) => {
    const doc = await editableDoc(ctx, documentId);
    if (doc.editor !== undefined) return "converted" as const;
    if (doc.conversionFailure) return "failed" as const;
    const room = await roomOf(ctx, documentId);
    if (room && room.claimToken !== claimToken) {
      // Another tab is converting right now — let it finish.
      if (Date.now() - room.claimedAt < STALE_CONVERSION_MS) return "busy" as const;
      await deleteRoomData(ctx, documentId);
    }
    return "ready" as const;
  },
});

/**
 * Switch a document to SuperDoc. `blocks` are the converted document's rows
 * (exactly what the editor's own extraction produces, so its first save is a
 * no-op); `from` names the TipTap block each came from, whose author and
 * timestamps it inherits — conversion isn't an edit, so attribution and
 * "since you last looked" carry over. The TipTap rows are kept in
 * `legacyBlocks`; deleted-block tombstones stay so pending deletions still
 * show in the diff.
 *
 * `basedOn` is the document's `updatedAt` when the editor read the TipTap
 * content. If a TipTap tab saved since, the conversion is stale and refused.
 */
export const finish = mutation({
  args: {
    documentId: v.id("documents"),
    basedOn: v.number(),
    blocks: v.array(
      v.object({
        blockId: v.string(),
        type: v.string(),
        content: v.string(),
        from: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { documentId, basedOn, blocks }) => {
    const doc = await editableDoc(ctx, documentId);
    if (doc.editor !== undefined) throw new ConvexError({ code: "ALREADY_CONVERTED" });
    if (doc.updatedAt !== basedOn) throw new ConvexError({ code: "CHANGED_DURING_CONVERSION" });
    if (!(await hasAnyUpdate(ctx, documentId, undefined))) throw new ConvexError({ code: "NO_CONTENT" });

    const identity = (await ctx.auth.getUserIdentity())!;
    const account = await ctx.db
      .query("users")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .unique();

    const rows = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();
    const now = Date.now();

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const { _id, _creationTime, ...row } of rows) {
      await ctx.db.insert("legacyBlocks", { ...row, convertedAt: now });
    }

    const live = new Map(rows.filter((r) => r.deletedAt === undefined).map((r) => [r.blockId, r]));
    const newIds = new Set(blocks.map((b) => b.blockId));
    for (const row of rows) {
      // Live rows are replaced; a tombstone stays unless its id is reused.
      if (row.deletedAt === undefined || newIds.has(row.blockId)) await ctx.db.delete(row._id);
    }

    const sources = new Map<string, number>();
    for (const b of blocks) if (b.from) sources.set(b.from, (sources.get(b.from) ?? 0) + 1);

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (new TextEncoder().encode(b.content).length > MAX_BLOCK_CONTENT_BYTES) {
        throw new ConvexError({ code: "BLOCK_TOO_LARGE", blockId: b.blockId });
      }
      const src = b.from ? live.get(b.from) : undefined;
      const oneToOne = src && sources.get(src.blockId) === 1 && ONE_TO_ONE_TYPES.has(src.type);
      await ctx.db.insert("blocks", {
        documentId,
        blockId: b.blockId,
        order: i,
        type: b.type,
        content: b.content,
        author: src ? src.author : identity.subject,
        authorName: src ? src.authorName : account?.displayName,
        createdAt: src?.createdAt ?? now,
        lastEditedAt: src?.lastEditedAt ?? now,
        previouslyDraftedBy: src?.previouslyDraftedBy,
        previousContent: oneToOne ? src.previousContent : undefined,
      });
    }

    // updatedAt is left alone: the words didn't change.
    await ctx.db.patch(documentId, { editor: "superdoc", conversionFailure: undefined });
  },
});

/** The conversion didn't check out: drop its room and remember why, so the
 *  document opens in TipTap and isn't retried on every open. */
export const fail = mutation({
  args: { documentId: v.id("documents"), reason: v.string() },
  handler: async (ctx, { documentId, reason }) => {
    const doc = await editableDoc(ctx, documentId);
    if (doc.editor !== undefined) return;
    await deleteRoomData(ctx, documentId);
    await ctx.db.patch(documentId, {
      conversionFailure: { reason: reason.slice(0, 1000), at: Date.now() },
    });
  },
});

/** Put a converted document back on TipTap from its `legacyBlocks` copy.
 *  Run by hand: `npx convex run conversion:revert '{"documentId": "…"}'`.
 *  Edits made in SuperDoc since the conversion are discarded. */
export const revert = internalMutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const legacy = await ctx.db
      .query("legacyBlocks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();
    if (legacy.length === 0) throw new ConvexError({ code: "NO_LEGACY_COPY" });
    const current = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();
    for (const row of current) await ctx.db.delete(row._id);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const { _id, _creationTime, convertedAt: _convertedAt, ...row } of legacy) {
      await ctx.db.insert("blocks", row);
      await ctx.db.delete(_id);
    }
    await deleteRoomData(ctx, documentId, "all");
    await ctx.db.patch(documentId, { editor: undefined, conversionFailure: undefined });
  },
});

/** Let a document whose conversion (to SuperDoc or to BlockNote) failed try
 *  again on its next open.
 *  `npx convex run conversion:clearFailure '{"documentId": "…"}'` */
export const clearFailure = internalMutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    await ctx.db.patch(documentId, { conversionFailure: undefined, blocknoteFailure: undefined });
  },
});

/** Where every document stands: `npx convex run conversion:status`. */
export const status = internalQuery({
  args: {},
  handler: async (ctx) => {
    const docs = (await ctx.db.query("documents").collect()).filter(
      (d) => d.deletedAt === undefined,
    );
    return docs.map((d) => ({
      documentId: d._id,
      title: d.title,
      editor: d.editor ?? "tiptap",
      failure: d.conversionFailure?.reason ?? d.blocknoteFailure?.reason,
    }));
  },
});

// ---- SuperDoc → BlockNote ----
//
// Same shape as the TipTap → SuperDoc conversion above, run by the BlockNote
// editor (src/components/BlockNoteEditor.tsx):
//   1. `prepareBlockNote` clears a BlockNote room left by a conversion that
//      never finished.
//   2. The editor claims the BlockNote room, builds the document from the
//      SuperDoc-derived block rows — keeping each block's id — and checks the
//      text came through.
//   3. `finishBlockNote` switches the document over.
// The SuperDoc Y.Doc is never touched, so `revertBlockNote` only has to drop
// the BlockNote room and flip the flag back.

/** Before converting to BlockNote: may this editor start? */
export const prepareBlockNote = mutation({
  args: { documentId: v.id("documents"), claimToken: v.string() },
  handler: async (ctx, { documentId, claimToken }) => {
    const doc = await editableDoc(ctx, documentId);
    if (doc.editor === "blocknote") return "converted" as const;
    if (doc.editor !== "superdoc") return "unsupported" as const;
    if (doc.blocknoteFailure) return "failed" as const;
    const room = await roomFor(ctx, documentId, "blocknote");
    if (room && room.claimToken !== claimToken) {
      if (Date.now() - room.claimedAt < STALE_CONVERSION_MS) return "busy" as const;
      await deleteRoomData(ctx, documentId, "blocknote");
    }
    return "ready" as const;
  },
});

/**
 * Switch a SuperDoc document to BlockNote. `blocks` are the BlockNote
 * document's rows, exactly as the editor's own extraction produces them, so
 * its first save is a no-op. Ids carry over from the SuperDoc rows, so each
 * row keeps its author and timestamps — conversion isn't an edit. A row whose
 * id didn't survive is dropped outright (its words are in another block; the
 * editor's text check made sure of that), not tombstoned as a deletion.
 */
export const finishBlockNote = mutation({
  args: {
    documentId: v.id("documents"),
    basedOn: v.number(),
    blocks: v.array(v.object({ blockId: v.string(), type: v.string(), content: v.string() })),
  },
  handler: async (ctx, { documentId, basedOn, blocks }) => {
    const doc = await editableDoc(ctx, documentId);
    if (doc.editor !== "superdoc") throw new ConvexError({ code: "NOT_SUPERDOC" });
    if (doc.updatedAt !== basedOn) throw new ConvexError({ code: "CHANGED_DURING_CONVERSION" });
    if (!(await hasAnyUpdate(ctx, documentId, "blocknote"))) {
      throw new ConvexError({ code: "NO_CONTENT" });
    }

    const identity = (await ctx.auth.getUserIdentity())!;
    const account = await ctx.db
      .query("users")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .unique();
    const rows = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();
    const byId = new Map(rows.map((r) => [r.blockId, r]));
    const kept = new Set<string>();
    const now = Date.now();

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (new TextEncoder().encode(b.content).length > MAX_BLOCK_CONTENT_BYTES) {
        throw new ConvexError({ code: "BLOCK_TOO_LARGE", blockId: b.blockId });
      }
      kept.add(b.blockId);
      const row = byId.get(b.blockId);
      if (row && row.deletedAt === undefined) {
        await ctx.db.patch(row._id, { order: i, type: b.type, content: b.content });
        continue;
      }
      if (row) await ctx.db.delete(row._id); // a tombstone whose id is back
      await ctx.db.insert("blocks", {
        documentId,
        blockId: b.blockId,
        order: i,
        type: b.type,
        content: b.content,
        author: identity.subject,
        authorName: account?.displayName,
        createdAt: now,
        lastEditedAt: now,
      });
    }
    for (const row of rows) {
      if (row.deletedAt === undefined && !kept.has(row.blockId)) await ctx.db.delete(row._id);
    }
    // updatedAt is left alone: the words didn't change.
    await ctx.db.patch(documentId, { editor: "blocknote" });
  },
});

/** The conversion didn't check out: drop its BlockNote room and remember
 *  why, so the document keeps opening in SuperDoc, untouched, and isn't
 *  retried on every open. */
export const failBlockNote = mutation({
  args: { documentId: v.id("documents"), reason: v.string() },
  handler: async (ctx, { documentId, reason }) => {
    const doc = await editableDoc(ctx, documentId);
    if (doc.editor !== "superdoc") return;
    await deleteRoomData(ctx, documentId, "blocknote");
    await ctx.db.patch(documentId, {
      blocknoteFailure: { reason: reason.slice(0, 1000), at: Date.now() },
    });
  },
});

/** Put a BlockNote document back on SuperDoc. Its SuperDoc Y.Doc was never
 *  touched, and the SuperDoc editor rebuilds the block rows from it on open.
 *  Edits made in BlockNote since the conversion are discarded.
 *  `npx convex run conversion:revertBlockNote '{"documentId": "…"}'` */
export const revertBlockNote = internalMutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const doc = await ctx.db.get(documentId);
    if (!doc) throw new ConvexError({ code: "NOT_FOUND" });
    if (doc.editor === "superdoc") {
      // A conversion that never finished — just clear its room.
      await deleteRoomData(ctx, documentId, "blocknote");
      return;
    }
    if (doc.editor !== "blocknote") throw new ConvexError({ code: "NOT_BLOCKNOTE" });
    if (!(await hasAnyUpdate(ctx, documentId, undefined))) {
      throw new ConvexError({ code: "NO_SUPERDOC_COPY" });
    }
    await deleteRoomData(ctx, documentId, "blocknote");
    await ctx.db.patch(documentId, { editor: "superdoc", blocknoteFailure: undefined });
  },
});
