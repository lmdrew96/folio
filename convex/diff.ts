import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { diffWords } from "diff";
import { decodeContent } from "./blockContent";
import { blockMarkdown, blockText } from "./blockMarkdown";
import { resolveAccess } from "./access";

/** Short preview for the diff panel. */
function textPreview(content: unknown, max = 100): string {
  const text = blockText(content);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Strip the indent every line shares. A SuperDoc list item is one block
 *  whose depth arrives as leading spaces; rendered on its own, 4+ of them
 *  would read as a code block instead of a list item. */
function dedent(md: string): string {
  const lines = md.split("\n");
  const indent = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length),
  );
  return Number.isFinite(indent) && indent > 0
    ? lines.map((l) => l.slice(indent)).join("\n")
    : md;
}

type DiffPart = { value: string; added?: boolean; removed?: boolean };

// Chars of unchanged context to keep on either side of a change, mirroring
// textPreview's cap so one edit inside a long paragraph doesn't render the
// whole block back into the panel.
const DIFF_CONTEXT = 60;

/** Word-level change between a block's prior and current text, with long
 *  unchanged runs elided to a bounded context window around the edit. */
function editDiff(oldContent: unknown, newContent: unknown): DiffPart[] {
  const parts = diffWords(blockText(oldContent), blockText(newContent));
  return parts.map((part, i): DiffPart => {
    if (part.added || part.removed) return part;
    if (part.value.length <= DIFF_CONTEXT * 2) return part;
    const head = i === 0 ? "" : part.value.slice(0, DIFF_CONTEXT);
    const tail = i === parts.length - 1 ? "" : part.value.slice(-DIFF_CONTEXT);
    const value = i === 0 ? `…${tail}` : i === parts.length - 1 ? `${head}…` : `${head}…${tail}`;
    return { value };
  });
}

type DiffItem = {
  blockId: string;
  type: string;
  preview: string;
  diff?: DiffPart[]; // edited items only, when a prior snapshot exists
  // Added/deleted items: the whole block as markdown, for the panel's
  // Markdown renderer (underline dropped — it escapes raw HTML).
  markdown?: string;
  author?: string;
  authorName?: string;
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
 * No watermark yet → empty, so the whole doc doesn't read as "new". Opening a
 * document sets one (ensureVisited), so that state only lasts a moment.
 */
export const diffSince = query({
  args: { documentId: v.id("documents"), userId: v.string() },
  handler: async (ctx, { documentId, userId }): Promise<Diff> => {
    const empty: Diff = { added: [], edited: [], deleted: [], hasWatermark: false };

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return empty;
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access) return empty;

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
        preview: textPreview(decodeContent(b.content)),
        author: b.author,
        authorName: b.authorName,
      };
      const markdown = () =>
        dedent(blockMarkdown(decodeContent(b.content), { underline: false }));
      if (b.deletedAt !== undefined) {
        if (b.deletedAt > since) deleted.push({ ...base, markdown: markdown(), at: b.deletedAt });
      } else if (b.createdAt > since) {
        added.push({ ...base, markdown: markdown(), at: b.createdAt });
      } else if (b.lastEditedAt > since) {
        edited.push({
          ...base,
          at: b.lastEditedAt,
          diff:
            b.previousContent !== undefined
              ? editDiff(decodeContent(b.previousContent), decodeContent(b.content))
              : undefined,
        });
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
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access) throw new Error("Not found");

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

/**
 * Give the caller a watermark on first open, so the changes panel starts
 * working without a manual "Mark caught up". Insert-only: an existing
 * watermark is never moved. Keyed to the signed-in user — never Cleo's
 * "claude" row or an MCP key's "mcp:<keyId>" row. Safe for the tombstone
 * purge, which only deletes tombstones older than every watermark.
 */
export const ensureVisited = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    if (!(await resolveAccess(ctx, documentId, identity))) return null;

    const existing = await ctx.db
      .query("visits")
      .withIndex("by_doc_user", (q) =>
        q.eq("documentId", documentId).eq("userId", identity.subject),
      )
      .unique();
    if (!existing) {
      await ctx.db.insert("visits", {
        documentId,
        userId: identity.subject,
        lastVisitedAt: Date.now(),
      });
    }
    return null;
  },
});

type ReactionItem = {
  blockId: string;
  type: string;
  author: string; // who last touched it ("nae" | "claude") — v1 attribution edge
  text: string;
  prevText: string | null;
  nextText: string | null;
};
type DeletedItem = {
  blockId: string;
  type: string;
  author: string;
  text: string;
};

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
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access) return empty;

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
        author: r.authorName ?? r.author ?? "Nae",
        text: blockText(decodeContent(r.content)),
        prevText: i > 0 ? blockText(decodeContent(live[i - 1].content)) : null,
        nextText: i < live.length - 1 ? blockText(decodeContent(live[i + 1].content)) : null,
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
            author: r.authorName ?? r.author ?? "Nae",
            text: blockText(decodeContent(r.content)),
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
