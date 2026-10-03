import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { decodeContent } from "./blockContent";
import { blockMarkdown, blockText } from "./blockMarkdown";
import { resolveAccessForUser } from "./access";

/**
 * Data layer for Folio's READ-ONLY MCP door — any user's AI of choice reading
 * that user's documents through a personal API key (convex/apiKeys.ts).
 *
 * Every function here is INTERNAL: callable only from other Convex functions,
 * never from the public internet. The sole caller is the key-gated MCP
 * httpAction in `convex/http.ts`, which resolves the key to its owner BEFORE
 * calling these. That trust boundary is why these take `userId` (and the key's
 * `watermark`) as explicit args — an MCP request carries no Clerk session.
 *
 * Access is the app's own rule (access.ts resolveAccessForUser): documents the
 * user owns plus ones shared with them, never trashed ones. Block JSON →
 * markdown lives in blockMarkdown.ts, shared with the changes panel.
 */

/** Short single-line preview for diff rows; the sibling calls read for the
 *  full body. Built from blockMarkdown (so list items are never squashed
 *  together) and then flattened to one line for compact display. */
function textPreview(content: unknown, max = 100): string {
  const text = blockMarkdown(content).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

type Readable = { doc: Doc<"documents">; role: "owner" | "editor" };

/** Every document the user can open — owned plus accepted shares, trash
 *  excluded — most-recently-edited first. The same rule as access.ts
 *  resolveAccessForUser, applied to the whole set at once. */
async function readableDocs(ctx: QueryCtx, userId: string): Promise<Readable[]> {
  const owned = await ctx.db
    .query("documents")
    .withIndex("by_owner", (q) => q.eq("ownerId", userId))
    .collect();
  const shares = await ctx.db
    .query("documentShares")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const shared = await Promise.all(
    shares.filter((s) => s.acceptedAt !== undefined).map((s) => ctx.db.get(s.documentId)),
  );
  const rows: Readable[] = [
    ...owned.map((doc) => ({ doc, role: "owner" as const })),
    ...shared
      .filter((d): d is Doc<"documents"> => d !== null && d.ownerId !== userId)
      .map((doc) => ({ doc, role: "editor" as const })),
  ];
  const seen = new Set<string>();
  return rows
    .filter(({ doc }) => doc.deletedAt === undefined && !seen.has(doc._id) && seen.add(doc._id))
    .sort((a, b) => b.doc.updatedAt - a.doc.updatedAt);
}

/** Live blocks of one document, in document order. */
async function liveBlocks(ctx: QueryCtx, documentId: Id<"documents">) {
  const rows = await ctx.db
    .query("blocks")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .collect();
  return rows.filter((b) => b.deletedAt === undefined).sort((a, b) => a.order - b.order);
}

const authorOf = (b: Doc<"blocks">): string =>
  // Cleo's blocks say "claude"; a human's carry their display name.
  b.author === "claude" ? "claude" : (b.authorName ?? "unknown");

type FolderInfo = { id: Id<"folders">; name: string; path: string; parentId: Id<"folders"> | null };

/** The user's folders keyed by id, each with its full "A / B / C" path. */
async function folderMap(ctx: QueryCtx, userId: string): Promise<Map<string, FolderInfo>> {
  const rows = await ctx.db
    .query("folders")
    .withIndex("by_owner", (q) => q.eq("ownerId", userId))
    .take(2000);
  const byId = new Map(rows.map((f) => [f._id as string, f]));
  const pathOf = (f: Doc<"folders">): string => {
    const names: string[] = [];
    // Bounded walk: a parent cycle can't hang the query.
    for (let cur: Doc<"folders"> | undefined = f, i = 0; cur && i < 64; i++) {
      names.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return names.join(" / ");
  };
  return new Map(
    rows.map((f) => [
      f._id as string,
      { id: f._id, name: f.name, path: pathOf(f), parentId: f.parentId ?? null },
    ]),
  );
}

/** A timestamp filter: an ISO 8601 date/time (a bare date is midnight UTC). */
function parseWhen(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`${name} must be an ISO 8601 date or date-time`);
  return ms;
}

/**
 * The readable documents, optionally narrowed by folder (subfolders included)
 * and by last-edit time. Each carries its folder — the OWNER's filing, so a
 * document shared with the user reads as unfiled, as it does in the app.
 */
export const listDocumentsForUser = internalQuery({
  args: {
    userId: v.string(),
    folderId: v.optional(v.string()),
    updatedAfter: v.optional(v.string()),
    updatedBefore: v.optional(v.string()),
  },
  handler: async (ctx, { userId, folderId, updatedAfter, updatedBefore }) => {
    const after = parseWhen(updatedAfter, "updatedAfter");
    const before = parseWhen(updatedBefore, "updatedBefore");
    const folders = await folderMap(ctx, userId);

    let inFolder: Set<string> | null = null;
    if (folderId !== undefined) {
      if (!folders.has(folderId)) throw new Error(`Folder ${folderId} not found`);
      inFolder = new Set([folderId]);
      // Pull in descendants until the set stops growing.
      for (let grew = true; grew; ) {
        grew = false;
        for (const f of folders.values()) {
          if (f.parentId && inFolder.has(f.parentId) && !inFolder.has(f.id)) {
            inFolder.add(f.id);
            grew = true;
          }
        }
      }
    }

    return (await readableDocs(ctx, userId))
      .map(({ doc, role }) => {
        const folder = role === "owner" && doc.folderId ? folders.get(doc.folderId) : undefined;
        return { doc, role, folder };
      })
      .filter(
        ({ doc, folder }) =>
          (!inFolder || (folder !== undefined && inFolder.has(folder.id))) &&
          (after === undefined || doc.updatedAt >= after) &&
          (before === undefined || doc.updatedAt <= before),
      )
      .map(({ doc, role, folder }) => ({
        id: doc._id,
        title: doc.title,
        shared: role === "editor",
        folder: folder ? { id: folder.id, name: folder.name, path: folder.path } : null,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      }));
  },
});

/** The user's folder tree, flat and sorted by path, with how many of their
 *  documents sit directly in each — enough to resolve a folder name to an id. */
export const listFoldersForUser = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const folders = await folderMap(ctx, userId);
    const direct = new Map<string, number>();
    for (const { doc, role } of await readableDocs(ctx, userId)) {
      if (role === "owner" && doc.folderId) {
        direct.set(doc.folderId, (direct.get(doc.folderId) ?? 0) + 1);
      }
    }
    return {
      folders: [...folders.values()]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((f) => ({ ...f, documentCount: direct.get(f.id) ?? 0 })),
    };
  },
});

const RANGE_LIMIT_DEFAULT = 20;
const RANGE_CONTEXT_DEFAULT = 5;
const RANGE_MAX = 200;

/**
 * Full current content of a doc the user can open — live blocks in document order,
 * each as markdown text (list items one per line, bold/italic/headings as
 * markdown syntax) with author attribution. null when not owned / not found.
 *
 * No migration needed for existing docs: storage already keeps list items as
 * discrete ProseMirror nodes (see convex/blocks.ts reconcile — `content` is
 * stored as-is from the editor's JSON, never flattened at write time). Bug 1
 * was purely a read-side artifact of the old `blockText` join; every existing
 * doc reads correctly the moment this function ships, nothing to backfill.
 */
export const readDocumentForUser = internalQuery({
  args: {
    userId: v.string(),
    documentId: v.id("documents"),
    // Optional window: `fromBlockId` + `limit` reads forward from a block;
    // `aroundBlockId` + `context` reads that many blocks either side of one.
    fromBlockId: v.optional(v.string()),
    limit: v.optional(v.number()),
    aroundBlockId: v.optional(v.string()),
    context: v.optional(v.number()),
    includeEmpty: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { userId, documentId, fromBlockId, aroundBlockId } = args;
    if (fromBlockId !== undefined && aroundBlockId !== undefined) {
      throw new Error("Pass fromBlockId or aroundBlockId, not both");
    }
    const access = await resolveAccessForUser(ctx, documentId, userId);
    if (!access) return null;
    const { doc } = access;

    const all = (await liveBlocks(ctx, documentId)).map((b) => ({
      blockId: b.blockId,
      type: b.type,
      author: authorOf(b),
      text: blockMarkdown(decodeContent(b.content)),
    }));
    // Blank lines are layout, not content — dropped unless asked for.
    const blocks = args.includeEmpty ? all : all.filter((b) => b.text.trim() !== "");

    let start = 0;
    let end = blocks.length;
    const anchor = fromBlockId ?? aroundBlockId;
    if (anchor !== undefined) {
      const at = blocks.findIndex((b) => b.blockId === anchor);
      if (at === -1) throw new Error(`Block ${anchor} not found in this document`);
      const count = (n: number | undefined, fallback: number) =>
        Math.min(Math.max(0, Math.floor(n ?? fallback)), RANGE_MAX);
      if (fromBlockId !== undefined) {
        start = at;
        end = at + Math.max(1, count(args.limit, RANGE_LIMIT_DEFAULT));
      } else {
        const context = count(args.context, RANGE_CONTEXT_DEFAULT);
        start = Math.max(0, at - context);
        end = at + context + 1;
      }
      end = Math.min(end, blocks.length);
    }

    return {
      id: doc._id,
      title: doc.title,
      updatedAt: doc.updatedAt,
      totalBlocks: blocks.length,
      ...(anchor !== undefined
        ? { range: { start, end }, hasMoreBefore: start > 0, hasMoreAfter: end < blocks.length }
        : {}),
      ...(args.includeEmpty ? {} : { emptyBlocksOmitted: all.length - blocks.length }),
      blocks: blocks.slice(start, end),
    };
  },
});

const SEARCH_LIMIT_DEFAULT = 20;
const SEARCH_LIMIT_MAX = 100;
const SNIPPET_CHARS = 160;

/** ~SNIPPET_CHARS of `text` centred on the match at [at, at + len). */
function snippetAround(text: string, at: number, len: number): string {
  const pad = Math.max(0, Math.floor((SNIPPET_CHARS - len) / 2));
  const start = Math.max(0, at - pad);
  const end = Math.min(text.length, at + len + pad);
  return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}

const countOf = (haystack: string, needle: string): number => {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
};

/**
 * Full-text search over the live blocks of every document the user can open.
 * Case-insensitive; every word of the query must appear in a block for it to
 * hit. Ranked by relevance (the whole phrase appearing, then how often the
 * words do, headings a little above body text), ties to the most recently
 * edited block.
 *
 * A scan, not a Convex search index: blocks store ProseMirror JSON with no
 * plain-text field to index, and Folio's library is small. If reads ever
 * approach Convex's per-query limits, add a derived `text` field + searchIndex.
 */
export const searchForUser = internalQuery({
  args: { userId: v.string(), query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { userId, query, limit }) => {
    const phrase = query.toLowerCase().replace(/\s+/g, " ").trim();
    const words = [...new Set(phrase.split(" ").filter(Boolean))];
    if (words.length === 0) throw new Error("folio_search requires a non-empty query");
    const max = Math.min(Math.max(1, Math.floor(limit ?? SEARCH_LIMIT_DEFAULT)), SEARCH_LIMIT_MAX);

    const hits: {
      documentId: Id<"documents">;
      documentTitle: string;
      blockId: string;
      blockType: string;
      snippet: string;
      author: string;
      updatedAt: number;
      score: number;
    }[] = [];
    for (const { doc } of await readableDocs(ctx, userId)) {
      for (const b of await liveBlocks(ctx, doc._id)) {
        const text = blockText(decodeContent(b.content));
        if (!text) continue;
        const lower = text.toLowerCase();
        if (!words.every((w) => lower.includes(w))) continue;

        const phraseAt = words.length > 1 ? lower.indexOf(phrase) : -1;
        const at = phraseAt !== -1 ? phraseAt : lower.indexOf(words[0]);
        const len = phraseAt !== -1 ? phrase.length : words[0].length;
        const score =
          (phraseAt !== -1 ? 10 : 0) +
          words.reduce((sum, w) => sum + Math.min(countOf(lower, w), 5), 0) +
          (b.type === "heading" ? 2 : 0);
        hits.push({
          documentId: doc._id,
          documentTitle: doc.title,
          blockId: b.blockId,
          blockType: b.type,
          snippet: snippetAround(text, at, len),
          author: authorOf(b),
          updatedAt: b.lastEditedAt,
          score,
        });
      }
    }
    hits.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
    return {
      query,
      totalHits: hits.length,
      hits: hits.slice(0, max).map((hit) => ({ ...hit, score: undefined })),
    };
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

type ChangeKind = "added" | "edited" | "deleted";

/** How a block changed after `since`, if it did — the diff's one rule. */
function changeOf(b: Doc<"blocks">, since: number): { kind: ChangeKind; at: number } | null {
  if (b.deletedAt !== undefined) {
    return b.deletedAt > since ? { kind: "deleted", at: b.deletedAt } : null;
  }
  if (b.createdAt > since) return { kind: "added", at: b.createdAt };
  if (b.lastEditedAt > since) return { kind: "edited", at: b.lastEditedAt };
  return null;
}

/** Every block row of a document, tombstones included (the diff needs them). */
const allBlocks = (ctx: QueryCtx, documentId: Id<"documents">) =>
  ctx.db
    .query("blocks")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .collect();

/** This key's watermark row for a document, if it has one. */
const visitOf = (ctx: QueryCtx, documentId: Id<"documents">, watermark: string) =>
  ctx.db
    .query("visits")
    .withIndex("by_doc_user", (q) => q.eq("documentId", documentId).eq("userId", watermark))
    .unique();

/**
 * What changed in a doc since this KEY last looked (`watermark`, "mcp:<keyId>").
 * Each key has its own watermark in the visits table — independent of the
 * user's own in-app watermark, Cleo's, and every other key's, because visits
 * is keyed (documentId, userId) and the key's watermark id rides as userId.
 * First look (no watermark) returns empty so the whole doc doesn't read as new.
 */
export const diffSinceForUser = internalQuery({
  args: {
    userId: v.string(),
    documentId: v.id("documents"),
    watermark: v.string(),
  },
  handler: async (ctx, { userId, documentId, watermark }): Promise<DiffResult> => {
    const empty: DiffResult = {
      added: [],
      edited: [],
      deleted: [],
      hasWatermark: false,
    };

    if (!(await resolveAccessForUser(ctx, documentId, userId))) return empty;

    const visit = await visitOf(ctx, documentId, watermark);
    if (!visit) return empty;
    const since = visit.lastVisitedAt;

    const lists: Record<ChangeKind, DiffItem[]> = { added: [], edited: [], deleted: [] };
    for (const b of await allBlocks(ctx, documentId)) {
      const change = changeOf(b, since);
      if (!change) continue;
      lists[change.kind].push({
        blockId: b.blockId,
        type: b.type,
        preview: textPreview(decodeContent(b.content)),
        author: authorOf(b),
        at: change.at,
      });
    }
    const { added, edited, deleted } = lists;

    const recentFirst = (x: DiffItem, y: DiffItem) => y.at - x.at;
    added.sort(recentFirst);
    edited.sort(recentFirst);
    deleted.sort(recentFirst);

    return { added, edited, deleted, hasWatermark: true };
  },
});

/**
 * Advance ONLY the calling key's watermark for a doc to now ("I've caught up").
 * The lone write the door allows — it touches the visits row keyed to this key,
 * never the document itself and never another watcher's watermark.
 */
export const markVisitedForUser = internalMutation({
  args: {
    userId: v.string(),
    documentId: v.id("documents"),
    watermark: v.string(),
  },
  handler: async (ctx, { userId, documentId, watermark }) => {
    if (!(await resolveAccessForUser(ctx, documentId, userId))) throw new Error("Not found");

    const now = Date.now();
    await advanceWatermark(ctx, documentId, watermark, now);
    return now;
  },
});

async function advanceWatermark(
  ctx: MutationCtx,
  documentId: Id<"documents">,
  watermark: string,
  now: number,
) {
  const existing = await visitOf(ctx, documentId, watermark);
  if (existing) {
    await ctx.db.patch(existing._id, { lastVisitedAt: now });
  } else {
    await ctx.db.insert("visits", { documentId, userId: watermark, lastVisitedAt: now });
  }
}

/**
 * One-call catch-up across every readable document: which ones changed since
 * this key last looked at each, with counts only (folio_diff_since_last_visit
 * has the detail). A document this key has never looked at is included and
 * flagged `hasWatermark: false` with null counts — "never looked" is signal,
 * and without a baseline there's nothing to count against. Documents with no
 * changes are left out. Most recently changed first.
 */
export const whatsNewForUser = internalQuery({
  args: { userId: v.string(), watermark: v.string() },
  handler: async (ctx, { userId, watermark }) => {
    const out: {
      documentId: Id<"documents">;
      title: string;
      updatedAt: number;
      hasWatermark: boolean;
      addedCount: number | null;
      editedCount: number | null;
      deletedCount: number | null;
    }[] = [];
    for (const { doc } of await readableDocs(ctx, userId)) {
      const base = { documentId: doc._id, title: doc.title, updatedAt: doc.updatedAt };
      const visit = await visitOf(ctx, doc._id, watermark);
      if (!visit) {
        out.push({
          ...base,
          hasWatermark: false,
          addedCount: null,
          editedCount: null,
          deletedCount: null,
        });
        continue;
      }
      // Any block change bumps the document's updatedAt (blocks.reconcile),
      // so an untouched document needs no block reads at all.
      if (doc.updatedAt <= visit.lastVisitedAt) continue;
      const counts: Record<ChangeKind, number> = { added: 0, edited: 0, deleted: 0 };
      for (const b of await allBlocks(ctx, doc._id)) {
        const change = changeOf(b, visit.lastVisitedAt);
        if (change) counts[change.kind]++;
      }
      if (counts.added + counts.edited + counts.deleted === 0) continue;
      out.push({
        ...base,
        hasWatermark: true,
        addedCount: counts.added,
        editedCount: counts.edited,
        deletedCount: counts.deleted,
      });
    }
    // readableDocs is already most-recently-edited first.
    return { documents: out };
  },
});

/** Advance this key's watermark on every readable document to now. Like
 *  markVisitedForUser, it writes only the key's own visits rows. */
export const markAllVisitedForUser = internalMutation({
  args: { userId: v.string(), watermark: v.string() },
  handler: async (ctx, { userId, watermark }) => {
    const now = Date.now();
    const docs = await readableDocs(ctx, userId);
    for (const { doc } of docs) await advanceWatermark(ctx, doc._id, watermark, now);
    return { watermark: now, documents: docs.length };
  },
});
