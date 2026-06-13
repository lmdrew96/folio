import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

/**
 * Data layer for Folio's READ-ONLY MCP — the external-Claude door (Coru, Cody,
 * the other siblings who live outside Folio). The mirror of the in-app
 * continuity layer: Cleo reaches OUT to pctx/Tangle; this lets an outside Claude
 * reach IN to Nae's docs.
 *
 * Every function here is INTERNAL: callable only from other Convex functions,
 * never from the public internet. The sole caller is the secret-gated MCP
 * httpAction in `convex/http.ts`, which validates the shared secret and resolves
 * the owner BEFORE calling these. That trust boundary is why these take
 * `ownerId` (and the caller's `identity`) as explicit args — an MCP request
 * carries no Clerk session, so the usual "derive identity from ctx.auth" rule
 * doesn't apply; the door upstream has already authenticated.
 *
 * The in-app queries in documents/blocks/diff are deliberately left untouched —
 * this is a separate, isolated read path so the external door can never regress
 * the editor. The small helpers below are kept local for the same reason.
 */

/** Plain text of a ProseMirror block's JSON (local copy — mirrors diff.ts). */
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

/** Short preview for diff rows; the sibling calls read for the full body. */
function textPreview(content: unknown, max = 100): string {
  const text = blockText(content);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Every document `ownerId` owns, most-recently-edited first. */
export const listDocumentsForOwner = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => {
    const docs = await ctx.db
      .query("documents")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();
    return docs
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((d) => ({
        id: d._id,
        title: d.title,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      }));
  },
});

/**
 * Full current content of a doc `ownerId` owns — live blocks in document order,
 * each as plain text with author attribution. null when not owned / not found.
 */
export const readDocumentForOwner = internalQuery({
  args: { ownerId: v.string(), documentId: v.id("documents") },
  handler: async (ctx, { ownerId, documentId }) => {
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.ownerId !== ownerId) return null;

    const rows = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();
    const blocks = rows
      .filter((b) => b.deletedAt === undefined)
      .sort((a, b) => a.order - b.order)
      .map((b) => ({
        blockId: b.blockId,
        type: b.type,
        author: b.author ?? "nae",
        text: blockText(b.content),
      }));

    return { id: doc._id, title: doc.title, updatedAt: doc.updatedAt, blocks };
  },
});

type DiffItem = {
  blockId: string;
  type: string;
  preview: string;
  author?: string;
  at: number;
};
type DiffResult = {
  added: DiffItem[];
  edited: DiffItem[];
  deleted: DiffItem[];
  hasWatermark: boolean;
};

/**
 * What changed in a doc since `identity` (the calling sibling) last looked.
 * Keyed to that sibling's OWN watermark in the visits table — independent of
 * Nae's and the in-app "claude" watermark, because visits is keyed
 * (documentId, userId) and we pass the sibling's name as userId. First look
 * (no watermark) returns empty so the whole doc doesn't read as "new".
 */
export const diffSinceForOwner = internalQuery({
  args: {
    ownerId: v.string(),
    documentId: v.id("documents"),
    identity: v.string(),
  },
  handler: async (ctx, { ownerId, documentId, identity }): Promise<DiffResult> => {
    const empty: DiffResult = {
      added: [],
      edited: [],
      deleted: [],
      hasWatermark: false,
    };

    const doc = await ctx.db.get(documentId);
    if (!doc || doc.ownerId !== ownerId) return empty;

    const visit = await ctx.db
      .query("visits")
      .withIndex("by_doc_user", (q) =>
        q.eq("documentId", documentId).eq("userId", identity),
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

/**
 * Advance ONLY the calling sibling's watermark for a doc to now ("I've caught
 * up"). The lone write the door allows — it touches the visits row keyed to this
 * sibling, never the document itself and never another watcher's watermark.
 */
export const markVisitedForOwner = internalMutation({
  args: {
    ownerId: v.string(),
    documentId: v.id("documents"),
    identity: v.string(),
  },
  handler: async (ctx, { ownerId, documentId, identity }) => {
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.ownerId !== ownerId) throw new Error("Not found");

    const now = Date.now();
    const existing = await ctx.db
      .query("visits")
      .withIndex("by_doc_user", (q) =>
        q.eq("documentId", documentId).eq("userId", identity),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { lastVisitedAt: now });
    } else {
      await ctx.db.insert("visits", {
        documentId,
        userId: identity,
        lastVisitedAt: now,
      });
    }
    return now;
  },
});
