import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Pull a short plain-text preview out of a ProseMirror block's JSON. */
function textPreview(content: unknown, max = 100): string {
  const parts: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const node = n as { text?: unknown; content?: unknown };
    if (typeof node.text === "string") parts.push(node.text);
    if (Array.isArray(node.content)) for (const c of node.content) walk(c);
  };
  walk(content);
  const text = parts.join("").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

type DiffItem = {
  blockId: string;
  type: string;
  preview: string;
  author?: string;
  at: number; // the timestamp relevant to the bucket (created / edited / deleted)
};

type Diff = {
  added: DiffItem[];
  edited: DiffItem[];
  deleted: DiffItem[];
  hasWatermark: boolean;
};

/**
 * THE killer feature. Compare the doc's blocks against the caller's last-visit
 * watermark and bucket what changed:
 *   - added:   created after the watermark, still live
 *   - edited:  created before, but last-edited after the watermark, still live
 *   - deleted: tombstoned after the watermark
 * No watermark yet (first touch) → empty, so the whole doc doesn't read as "new".
 */
export const diffSince = query({
  args: { documentId: v.id("documents"), userId: v.string() },
  handler: async (ctx, { documentId, userId }): Promise<Diff> => {
    const empty: Diff = { added: [], edited: [], deleted: [], hasWatermark: false };

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return empty;
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.ownerId !== identity.subject) return empty;

    const visit = await ctx.db
      .query("visits")
      .withIndex("by_doc_user", (q) =>
        q.eq("documentId", documentId).eq("userId", userId),
      )
      .unique();
    if (!visit) return empty;
    const since = visit.lastVisitedAt;

    const rows = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();

    const added: DiffItem[] = [];
    const edited: DiffItem[] = [];
    const deleted: DiffItem[] = [];

    for (const b of rows) {
      const base = {
        blockId: b.blockId,
        type: b.type,
        preview: textPreview(b.content),
        author: b.author,
      };
      if (b.deletedAt !== undefined) {
        if (b.deletedAt > since) deleted.push({ ...base, at: b.deletedAt });
      } else if (b.createdAt > since) {
        added.push({ ...base, at: b.createdAt });
      } else if (b.lastEditedAt > since) {
        edited.push({ ...base, at: b.lastEditedAt });
      }
    }

    const recentFirst = (x: DiffItem, y: DiffItem) => y.at - x.at;
    added.sort(recentFirst);
    edited.sort(recentFirst);
    deleted.sort(recentFirst);

    return { added, edited, deleted, hasWatermark: true };
  },
});

/** Upsert the caller's last-visit watermark for a doc to now ("mark caught up"). */
export const markVisited = mutation({
  args: { documentId: v.id("documents"), userId: v.string() },
  handler: async (ctx, { documentId, userId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.ownerId !== identity.subject) throw new Error("Not found");

    const now = Date.now();
    const existing = await ctx.db
      .query("visits")
      .withIndex("by_doc_user", (q) =>
        q.eq("documentId", documentId).eq("userId", userId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { lastVisitedAt: now });
    } else {
      await ctx.db.insert("visits", { documentId, userId, lastVisitedAt: now });
    }
    return now;
  },
});
