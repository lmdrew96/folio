import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { resolveAccess } from "./access";
import { rememberFriend } from "./friends";
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
 * retention window, cascading to their blocks/visits/reactions/messages/shares.
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

      const [blocks, visits, reactions, messages, shares] = await Promise.all([
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
        ctx.db
          .query("documentShares")
          .withIndex("by_document", (q) => q.eq("documentId", doc._id))
          .collect(),
      ]);

      await Promise.all([
        ...blocks.map((b) => ctx.db.delete(b._id)),
        ...visits.map((visit) => ctx.db.delete(visit._id)),
        ...reactions.map((r) => ctx.db.delete(r._id)),
        ...messages.map((m) => ctx.db.delete(m._id)),
        ...shares.map((s) => ctx.db.delete(s._id)),
        ctx.db.delete(doc._id),
      ]);
    }
  },
});
