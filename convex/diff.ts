import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Full plain text of a ProseMirror block's JSON. */
function blockText(content: unknown): string {
  const parts: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const node = n as { text?: unknown; content?: unknown };
    if (typeof node.text === "string") parts.push(node.text);
    if (Array.isArray(node.content)) for (const c of node.content) walk(c);
  };
  walk(content);
  return parts.join("").replace(/\s+/g, " ").trim();
}

/** Short preview for the diff panel. */
function textPreview(content: unknown, max = 100): string {
  const text = blockText(content);
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

type ReactionItem = {
  blockId: string;
  type: string;
  text: string;
  prevText: string | null;
  nextText: string | null;
};
type DeletedItem = { blockId: string; type: string; text: string };

/**
 * Patch 5 — the payload the in-app Claude reacts to. Like diffSince, but keyed
 * to Claude's own "claude" watermark, with FULL block text (not previews) and
 * the immediately adjacent blocks for context so Claude isn't reacting blind.
 *
 * First look (no watermark): returns the whole live doc as `added` + firstLook
 * so the very first reaction has something to chew on; the route advances the
 * watermark afterward, so subsequent reactions are diffs only.
 *
 * NOTE: deliberately dumb — no prefs, no Tangle, no identity. That continuity
 * layer is a separate v1 patch on purpose (don't blur what P5 proves).
 */
export const reactionPayload = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const empty = {
      hasChanges: false,
      firstLook: false,
      added: [] as ReactionItem[],
      edited: [] as ReactionItem[],
      deleted: [] as DeletedItem[],
    };

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return empty;
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.ownerId !== identity.subject) return empty;

    const rows = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();

    const live = rows
      .filter((r) => r.deletedAt === undefined)
      .sort((a, b) => a.order - b.order);

    const withContext = (blockId: string): ReactionItem | null => {
      const i = live.findIndex((r) => r.blockId === blockId);
      if (i === -1) return null;
      const r = live[i];
      return {
        blockId: r.blockId,
        type: r.type,
        text: blockText(r.content),
        prevText: i > 0 ? blockText(live[i - 1].content) : null,
        nextText: i < live.length - 1 ? blockText(live[i + 1].content) : null,
      };
    };

    const visit = await ctx.db
      .query("visits")
      .withIndex("by_doc_user", (q) =>
        q.eq("documentId", documentId).eq("userId", "claude"),
      )
      .unique();

    if (!visit) {
      const added = live
        .map((r) => withContext(r.blockId))
        .filter((x): x is ReactionItem => x !== null);
      return {
        hasChanges: added.length > 0,
        firstLook: true,
        added,
        edited: [] as ReactionItem[],
        deleted: [] as DeletedItem[],
      };
    }

    const since = visit.lastVisitedAt;
    const added: ReactionItem[] = [];
    const edited: ReactionItem[] = [];
    const deleted: DeletedItem[] = [];

    for (const r of rows) {
      if (r.deletedAt !== undefined) {
        if (r.deletedAt > since) {
          deleted.push({
            blockId: r.blockId,
            type: r.type,
            text: blockText(r.content),
          });
        }
      } else if (r.createdAt > since) {
        const item = withContext(r.blockId);
        if (item) added.push(item);
      } else if (r.lastEditedAt > since) {
        const item = withContext(r.blockId);
        if (item) edited.push(item);
      }
    }

    return {
      hasChanges: added.length + edited.length + deleted.length > 0,
      firstLook: false,
      added,
      edited,
      deleted,
    };
  },
});
