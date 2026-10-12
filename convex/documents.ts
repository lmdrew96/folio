import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { resolveAccess } from "./access";
import { rememberFriend } from "./friends";
import { ownFolder } from "./folders";
import { deleteRoomData } from "./ydoc";
import { liveBlocks } from "./mcpData";
import { blockMarkdown, blockText } from "./blockMarkdown";
import { decodeContent, MAX_BLOCK_CONTENT_BYTES } from "./blockContent";
import type { Doc } from "./_generated/dataModel";

// How long a soft-deleted document stays recoverable before the daily purge
// cron (convex/crons.ts) hard-deletes it and cascades to its children.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Every document the caller owns or has accepted-share access to, most-
 *  recently-edited first. Reactive. Each row is tagged with the caller's
 *  role so the UI can badge "Shared" and hide owner-only controls. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const owned = await ctx.db
      .query("documents")
      .withIndex("by_owner", (q) => q.eq("ownerId", identity.subject))
      .collect();

    const shares = await ctx.db
      .query("documentShares")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .collect();
    const sharedDocs = await Promise.all(
      shares
        .filter((s) => s.acceptedAt !== undefined)
        .map((s) => ctx.db.get(s.documentId)),
    );

    const rows: { doc: Doc<"documents">; role: "owner" | "editor" }[] = [
      ...owned.map((doc) => ({ doc, role: "owner" as const })),
      ...sharedDocs
        .filter((d): d is Doc<"documents"> => d !== null)
        .map((doc) => ({ doc, role: "editor" as const })),
    ];

    return rows
      .filter((r) => r.doc.deletedAt === undefined)
      .sort((a, b) => b.doc.updatedAt - a.doc.updatedAt)
      .map((r) => ({
        _id: r.doc._id,
        title: r.doc.title,
        createdAt: r.doc.createdAt,
        updatedAt: r.doc.updatedAt,
        role: r.role,
        // The owner's private filing — never exposed on a shared row.
        folderId: r.role === "owner" ? r.doc.folderId : undefined,
      }));
  },
});

/** Fetch a document the caller owns or has accepted-share access to. */
export const get = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access) return null;
    return { ...access.doc, role: access.role };
  },
});

/** Create a fresh untitled document and return its id — filed straight into
 *  `folderId` when it's created from inside a folder. Every new document is a
 *  BlockNote document (see schema.ts); `editor` is still accepted so a tab on
 *  an older build can create one, but it no longer changes anything. */
export const create = mutation({
  args: {
    folderId: v.optional(v.id("folders")),
    editor: v.optional(v.literal("superdoc")),
  },
  handler: async (ctx, { folderId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    if (folderId) await ownFolder(ctx, folderId, identity.subject);
    const now = Date.now();
    return await ctx.db.insert("documents", {
      ownerId: identity.subject,
      title: "Untitled",
      createdAt: now,
      updatedAt: now,
      folderId,
      editor: "blocknote",
    });
  },
});

/** File a document into one of the owner's folders (null = unfiled) —
 *  owner-only. Deliberately leaves updatedAt alone: filing isn't an edit, and
 *  it shouldn't jump the document to the top of "last edited". */
export const moveToFolder = mutation({
  args: {
    documentId: v.id("documents"),
    folderId: v.union(v.id("folders"), v.null()),
  },
  handler: async (ctx, { documentId, folderId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access || access.role !== "owner") throw new Error("Not found");
    if (folderId) await ownFolder(ctx, folderId, identity.subject);

    await ctx.db.patch(documentId, { folderId: folderId ?? undefined });
  },
});

/** Rename a document — owner-only. Blank titles fall back to "Untitled". */
export const rename = mutation({
  args: { documentId: v.id("documents"), title: v.string() },
  handler: async (ctx, { documentId, title }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access || access.role !== "owner") throw new Error("Not found");

    const trimmed = title.trim();
    await ctx.db.patch(documentId, {
      title: trimmed.length > 0 ? trimmed : "Untitled",
      updatedAt: Date.now(),
    });
  },
});

/**
 * Soft-delete a document — owner-only. Sets a tombstone instead of an
 * immediate hard delete, so the client can offer an "Undo" toast. Blocks,
 * visits, reactions, messages, and shares are left untouched (restorable via
 * `restore`); the daily purge cron (convex/crons.ts → purgeDeleted below)
 * hard-deletes the document and cascades to its children once the tombstone
 * outlives the retention window.
 */
export const remove = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access || access.role !== "owner") throw new Error("Not found");

    await ctx.db.patch(documentId, { deletedAt: Date.now() });
  },
});

/** Undo a pending delete — owner-only. Clears the tombstone so the document
 *  reappears. */
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

/** Set the document's prose font — any collaborator (owner or editor) can
 *  change it, same as any other in-editor formatting choice. */
export const setFontFamily = mutation({
  args: { documentId: v.id("documents"), fontFamily: v.string() },
  handler: async (ctx, { documentId, fontFamily }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access) throw new Error("Not found");

    await ctx.db.patch(documentId, { fontFamily, updatedAt: Date.now() });
  },
});

/** Set (or clear, with null) the document's word-count goal — any
 *  collaborator can set it, same as font family. */
export const setWordGoal = mutation({
  args: { documentId: v.id("documents"), wordGoal: v.union(v.number(), v.null()) },
  handler: async (ctx, { documentId, wordGoal }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access) throw new Error("Not found");
    if (wordGoal !== null && (!Number.isFinite(wordGoal) || wordGoal <= 0)) {
      throw new Error("Word goal must be a positive number");
    }

    await ctx.db.patch(documentId, {
      wordGoal: wordGoal ?? undefined,
      updatedAt: Date.now(),
    });
  },
});

/** An upload URL for an application-prompt screenshot (setApplication). */
export const applicationUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    return await ctx.storage.generateUploadUrl();
  },
});

/** Save what this document is written for — the application prompt (text,
 *  a screenshot, or both) and its word limit. Any collaborator can, as with
 *  the word goal. `imageId: null` removes the screenshot; omitted keeps it. */
export const setApplication = mutation({
  args: {
    documentId: v.id("documents"),
    prompt: v.string(),
    wordLimit: v.union(v.number(), v.null()),
    imageId: v.optional(v.union(v.id("_storage"), v.null())),
  },
  handler: async (ctx, { documentId, prompt, wordLimit, imageId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access) throw new Error("Not found");
    if (wordLimit !== null && (!Number.isInteger(wordLimit) || wordLimit <= 0)) {
      throw new Error("Word limit must be a whole number above 0");
    }
    const previous = access.doc.application?.imageId;
    const nextImage = imageId === undefined ? previous : (imageId ?? undefined);
    if (!prompt.trim() && !nextImage) throw new Error("Add the prompt's text or a screenshot of it");

    if (previous && previous !== nextImage) await ctx.storage.delete(previous);
    await ctx.db.patch(documentId, {
      application: {
        prompt: prompt.trim(),
        ...(wordLimit !== null ? { wordLimit } : {}),
        ...(nextImage ? { imageId: nextImage } : {}),
      },
    });
  },
});

/** Forget the application prompt (and its screenshot). */
export const clearApplication = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access) throw new Error("Not found");
    const imageId = access.doc.application?.imageId;
    if (imageId) await ctx.storage.delete(imageId);
    await ctx.db.patch(documentId, { application: undefined });
  },
});

/** The application prompt with a viewable screenshot URL — for the panel. */
export const application = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const access = await resolveAccess(ctx, documentId, identity);
    const app = access?.doc.application;
    if (!app) return null;
    return {
      prompt: app.prompt,
      wordLimit: app.wordLimit ?? null,
      imageUrl: app.imageId ? await ctx.storage.getUrl(app.imageId) : null,
    };
  },
});

/** Everything Cleo's application check reads: the prompt, the screenshot's
 *  URL, and the draft as markdown with its word count (whitespace-split, as
 *  the editor's footer counts). */
export const applicationCheck = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const access = await resolveAccess(ctx, documentId, identity);
    const app = access?.doc.application;
    if (!app) return null;
    const contents = (await liveBlocks(ctx, documentId)).map((b) => decodeContent(b.content));
    const draft = contents
      .map((c) => blockMarkdown(c, { underline: false }))
      .filter((t) => t.trim() !== "")
      .join("\n\n");
    const words = contents.map(blockText).join(" ").trim();
    return {
      title: access.doc.title,
      prompt: app.prompt,
      wordLimit: app.wordLimit ?? null,
      imageUrl: app.imageId ? await ctx.storage.getUrl(app.imageId) : null,
      draft,
      wordCount: words ? words.split(/\s+/).length : 0,
    };
  },
});

const wordsIn = (content: unknown): number => {
  const text = blockText(decodeContent(content));
  return text ? text.split(/\s+/).length : 0;
};

/**
 * The desk's look-back: every document touched or created since `since` (the
 * client's local midnight six days ago), with roughly how many words the
 * caller added to each — new blocks they wrote, plus growth in blocks they
 * edited (a block keeps only its one previous version, so a block edited
 * several times counts its last edit). Cleo's blocks don't count as theirs.
 */
export const weekRecap = query({
  args: { since: v.number() },
  handler: async (ctx, { since }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const me = identity.subject;

    const owned = await ctx.db
      .query("documents")
      .withIndex("by_owner", (q) => q.eq("ownerId", me))
      .collect();
    const shares = await ctx.db
      .query("documentShares")
      .withIndex("by_user", (q) => q.eq("userId", me))
      .collect();
    const shared = await Promise.all(
      shares.filter((sh) => sh.acceptedAt !== undefined).map((sh) => ctx.db.get(sh.documentId)),
    );

    const recap = [];
    for (const doc of [...owned, ...shared]) {
      if (!doc || doc.deletedAt !== undefined || doc.updatedAt < since) continue;
      const blocks = await ctx.db
        .query("blocks")
        .withIndex("by_document", (q) => q.eq("documentId", doc._id))
        .collect();
      let wordsAdded = 0;
      for (const b of blocks) {
        if (b.author !== me || b.deletedAt !== undefined || b.lastEditedAt < since) continue;
        if (b.createdAt >= since) wordsAdded += wordsIn(b.content);
        else if (b.previousContent !== undefined) {
          wordsAdded += Math.max(0, wordsIn(b.content) - wordsIn(b.previousContent));
        }
      }
      recap.push({
        id: doc._id,
        title: doc.title,
        created: doc.createdAt >= since,
        updatedAt: doc.updatedAt,
        wordsAdded,
        folderId: doc.ownerId === me ? doc.folderId : undefined,
      });
    }
    return recap.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

/** How many documents one review sheet can draw on. */
export const REVIEW_MAX_SOURCES = 10;

/** The notes a review sheet is built from: each document's title, dates and
 *  text as markdown, in the order given. Documents the caller can't open are
 *  left out. */
export const reviewSources = query({
  args: { documentIds: v.array(v.id("documents")) },
  handler: async (ctx, { documentIds }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    if (documentIds.length > REVIEW_MAX_SOURCES) {
      throw new Error(`A review sheet can use up to ${REVIEW_MAX_SOURCES} documents`);
    }
    const sources = [];
    for (const documentId of documentIds) {
      const access = await resolveAccess(ctx, documentId, identity);
      if (!access || access.doc.deletedAt !== undefined) continue;
      const markdown = (await liveBlocks(ctx, documentId))
        .map((b) => blockMarkdown(decodeContent(b.content), { underline: false }))
        .filter((t) => t.trim() !== "")
        .join("\n\n");
      sources.push({
        id: access.doc._id,
        title: access.doc.title,
        createdAt: access.doc.createdAt,
        updatedAt: access.doc.updatedAt,
        markdown,
      });
    }
    return sources;
  },
});

/**
 * A new document holding a review sheet Cleo wrote, filed in `folderId`.
 * The caller owns it, so it can be edited like any other document, but its
 * blocks are authored by Cleo ("claude"). `blocks` are the BlockNote rows of
 * the sheet (src/blocknote/rows.ts toRows); the editor seeds the document's
 * Y.Doc from them the first time it's opened.
 */
export const createReviewSheet = mutation({
  args: {
    folderId: v.optional(v.id("folders")),
    title: v.string(),
    blocks: v.array(v.object({ blockId: v.string(), type: v.string(), content: v.string() })),
  },
  handler: async (ctx, { folderId, title, blocks }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    if (folderId) await ownFolder(ctx, folderId, identity.subject);
    if (blocks.length === 0) throw new Error("The review sheet is empty");
    const now = Date.now();
    const documentId = await ctx.db.insert("documents", {
      ownerId: identity.subject,
      title: title.trim() || "Review sheet",
      createdAt: now,
      updatedAt: now,
      folderId,
      editor: "blocknote",
    });
    for (const [i, b] of blocks.entries()) {
      const content = b.content; // already the stored string form (blockContent.ts)
      if (new TextEncoder().encode(content).length > MAX_BLOCK_CONTENT_BYTES) {
        throw new Error("A section of the review sheet is too long to save");
      }
      await ctx.db.insert("blocks", {
        documentId,
        blockId: b.blockId,
        order: i + 1,
        type: b.type,
        content,
        author: "claude",
        createdAt: now,
        lastEditedAt: now,
      });
    }
    return documentId;
  },
});

/**
 * Invite someone onto a document by email — owner-only. If they already
 * have a Folio account (a `users` row for that email), the share resolves
 * immediately; otherwise it's pending until they sign in and `users.upsertUser`
 * resolves it. No-ops if a share for this (document, email) already exists.
 */
export const invite = mutation({
  args: { documentId: v.id("documents"), email: v.string() },
  handler: async (ctx, { documentId, email }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.ownerId !== identity.subject) throw new Error("Not found");

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) throw new Error("Email is required");

    const existing = await ctx.db
      .query("documentShares")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();
    if (existing.some((s) => s.invitedEmail === normalizedEmail)) return;

    const account = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", normalizedEmail))
      .unique();
    const now = Date.now();

    await ctx.db.insert("documentShares", {
      documentId,
      invitedEmail: normalizedEmail,
      userId: account?.userId,
      displayName: account?.displayName,
      invitedAt: now,
      acceptedAt: account ? now : undefined,
    });

    await rememberFriend(
      ctx,
      identity.subject,
      normalizedEmail,
      account ? { userId: account.userId, displayName: account.displayName } : null,
    );
  },
});

/** Collaborators (pending + accepted) on a document — owner or editor. */
export const listCollaborators = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access) return [];

    const shares = await ctx.db
      .query("documentShares")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();

    return shares.map((s) => ({
      _id: s._id,
      invitedEmail: s.invitedEmail,
      displayName: s.displayName,
      accepted: s.acceptedAt !== undefined,
    }));
  },
});

/** Revoke a collaborator's access — owner-only. */
export const revokeShare = mutation({
  args: { documentId: v.id("documents"), shareId: v.id("documentShares") },
  handler: async (ctx, { documentId, shareId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.ownerId !== identity.subject) throw new Error("Not found");

    const share = await ctx.db.get(shareId);
    if (!share || share.documentId !== documentId) return;
    await ctx.db.delete(shareId);
  },
});

/**
 * Hard-delete documents whose soft-delete tombstone is older than the
 * retention window, cascading to their blocks/visits/reactions/messages/shares
 * and SuperDoc room data.
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

      const [blocks, legacyBlocks, visits, reactions, messages, shares] = await Promise.all([
        ctx.db
          .query("blocks")
          .withIndex("by_document", (q) => q.eq("documentId", doc._id))
          .collect(),
        ctx.db
          .query("legacyBlocks")
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
        ctx.db
          .query("documentShares")
          .withIndex("by_document", (q) => q.eq("documentId", doc._id))
          .collect(),
      ]);

      await Promise.all([
        ...blocks.map((b) => ctx.db.delete(b._id)),
        ...legacyBlocks.map((b) => ctx.db.delete(b._id)),
        ...visits.map((visit) => ctx.db.delete(visit._id)),
        ...reactions.map((r) => ctx.db.delete(r._id)),
        ...messages.map((m) => ctx.db.delete(m._id)),
        ...shares.map((s) => ctx.db.delete(s._id)),
        deleteRoomData(ctx, doc._id, "all"), // every editor's Y.Doc log + snapshot blobs
        ...(doc.application?.imageId ? [ctx.storage.delete(doc.application.imageId)] : []),
        ctx.db.delete(doc._id),
      ]);
    }
  },
});
