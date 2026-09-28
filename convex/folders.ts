import { mutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

/**
 * The owner's private filing system. Folders nest (parentId), carry a curated
 * color key, and never delete documents: removing a folder moves its
 * documents and subfolders up one level.
 */

// Mirrors FOLDER_COLORS in src/lib/folders.ts — kept local so the client
// bundle never imports a Convex server file.
const COLOR_KEYS = ["poppy", "mecca", "usugaki", "herbs", "indigo", "violet"];
const NAME_MAX = 80;

function cleanName(name: string): string {
  const trimmed = name.trim().slice(0, NAME_MAX);
  return trimmed.length > 0 ? trimmed : "New folder";
}

function checkColor(color: string | null | undefined): string | undefined {
  if (color === null || color === undefined) return undefined;
  if (!COLOR_KEYS.includes(color)) throw new Error("Unknown folder color");
  return color;
}

/** The caller's folder, or throw — one error for "missing" and "not yours",
 *  so a folder id can't be probed. */
export async function ownFolder(ctx: QueryCtx, folderId: Id<"folders">, ownerId: string) {
  const folder = await ctx.db.get(folderId);
  if (!folder || folder.ownerId !== ownerId) throw new Error("Not found");
  return folder;
}

async function requireIdentity(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  return identity;
}

/** Every folder the caller owns, flat — the client builds the tree. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const folders = await ctx.db
      .query("folders")
      .withIndex("by_owner", (q) => q.eq("ownerId", identity.subject))
      .take(2000);
    return folders.map((f) => ({
      _id: f._id,
      name: f.name,
      color: f.color,
      parentId: f.parentId,
      createdAt: f.createdAt,
    }));
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    parentId: v.optional(v.id("folders")),
    color: v.optional(v.string()),
  },
  handler: async (ctx, { name, parentId, color }) => {
    const identity = await requireIdentity(ctx);
    if (parentId) await ownFolder(ctx, parentId, identity.subject);
    return await ctx.db.insert("folders", {
      ownerId: identity.subject,
      name: cleanName(name),
      color: checkColor(color),
      parentId,
      createdAt: Date.now(),
    });
  },
});

export const rename = mutation({
  args: { folderId: v.id("folders"), name: v.string() },
  handler: async (ctx, { folderId, name }) => {
    const identity = await requireIdentity(ctx);
    await ownFolder(ctx, folderId, identity.subject);
    await ctx.db.patch(folderId, { name: cleanName(name) });
  },
});

export const setColor = mutation({
  args: { folderId: v.id("folders"), color: v.union(v.string(), v.null()) },
  handler: async (ctx, { folderId, color }) => {
    const identity = await requireIdentity(ctx);
    await ownFolder(ctx, folderId, identity.subject);
    await ctx.db.patch(folderId, { color: checkColor(color) });
  },
});

/** Re-parent a folder (null = top level). Refuses to move a folder into
 *  itself or any of its own descendants, which would detach a loop. */
export const move = mutation({
  args: { folderId: v.id("folders"), parentId: v.union(v.id("folders"), v.null()) },
  handler: async (ctx, { folderId, parentId }) => {
    const identity = await requireIdentity(ctx);
    await ownFolder(ctx, folderId, identity.subject);
    if (parentId) {
      let cursor: Id<"folders"> | undefined = parentId;
      while (cursor) {
        if (cursor === folderId) throw new Error("Can't move a folder inside itself");
        const ancestor = await ownFolder(ctx, cursor, identity.subject);
        cursor = ancestor.parentId;
      }
    }
    await ctx.db.patch(folderId, { parentId: parentId ?? undefined });
  },
});

/** Delete a folder. Its documents and subfolders move up to its parent (or
 *  to the top level / unfiled) — deleting a folder never deletes writing. */
export const remove = mutation({
  args: { folderId: v.id("folders") },
  handler: async (ctx, { folderId }) => {
    const identity = await requireIdentity(ctx);
    const folder = await ownFolder(ctx, folderId, identity.subject);

    for await (const child of ctx.db
      .query("folders")
      .withIndex("by_parent", (q) => q.eq("parentId", folderId))) {
      await ctx.db.patch(child._id, { parentId: folder.parentId });
    }
    // Includes soft-deleted documents, so an Undo after this still lands
    // somewhere real instead of pointing at a folder that's gone.
    for await (const doc of ctx.db
      .query("documents")
      .withIndex("by_folder", (q) => q.eq("folderId", folderId))) {
      await ctx.db.patch(doc._id, { folderId: folder.parentId });
    }
    await ctx.db.delete(folderId);
  },
});
