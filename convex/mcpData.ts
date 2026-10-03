import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { decodeContent } from "./blockContent";
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
 * user owns plus ones shared with them, never trashed ones. The small
 * serialization helpers below are kept local so this door can't regress the
 * editor's own queries.
 */

const SEPARATED = new Set(["tableCell", "tableHeader", "paragraph", "heading", "listItem"]);

/** Plain text of a ProseMirror block's JSON (local copy — mirrors diff.ts).
 *  Flattens everything with no structural separator — fine as a last-resort
 *  fallback for unrecognized node types, but NOT for list content (see
 *  blockMarkdown below, which is what read/preview paths actually use). */
function blockText(content: unknown): string {
  const parts: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const node = n as { type?: unknown; text?: unknown; content?: unknown };
    if (typeof node.text === "string") parts.push(node.text);
    if (Array.isArray(node.content)) for (const c of node.content) walk(c);
    // Cells, items and lines are separate words, not one run: "Name" + "Age" ≠ "NameAge".
    if (typeof node.type === "string" && SEPARATED.has(node.type)) parts.push(" ");
  };
  walk(content);
  return parts.join("").replace(/\s+/g, " ").trim();
}

/** Minimal shape of a ProseMirror/TipTap JSON node, as stored in a block row's
 *  `content` field (see convex/schema.ts — one top-level editor node per row). */
type PMNode = {
  type?: string;
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
  content?: PMNode[];
};

const hasMark = (marks: PMNode["marks"], type: string) =>
  marks?.some((m) => m.type === type) ?? false;

/** Inline run (a paragraph/heading's `content`) → markdown text, applying
 *  bold/italic/strike/underline/code/link marks. Concatenated directly —
 *  these are genuinely adjacent text runs within one line, not separate
 *  items. Link href wraps around the already-formatted text (Tiptap's Link
 *  mark, attrs.href — see @tiptap/extension-link), matching the
 *  `[**text**](href)` convention so the URL survives the round trip to the
 *  MCP client instead of vanishing. `code` short-circuits the rest: Tiptap's
 *  Code mark sets `excludes: '_'`, so a code run never carries any other
 *  mark — backticks would otherwise collide with `**`/`~~`/`<u>` wrapping. */
function mdInline(nodes: PMNode[] | undefined): string {
  if (!nodes) return "";
  let out = "";
  for (const n of nodes) {
    if (typeof n.text !== "string") continue;
    if (hasMark(n.marks, "code")) {
      out += `\`${n.text}\``;
      continue;
    }
    let t = n.text;
    if (hasMark(n.marks, "bold")) t = `**${t}**`;
    if (hasMark(n.marks, "italic")) t = `*${t}*`;
    if (hasMark(n.marks, "strike")) t = `~~${t}~~`;
    if (hasMark(n.marks, "underline")) t = `<u>${t}</u>`;
    const href = n.marks?.find((m) => m.type === "link")?.attrs?.href;
    if (typeof href === "string" && href) t = `[${t}](${href})`;
    out += t;
  }
  return out;
}

/** bulletList/orderedList → one markdown line per item (nested lists indented).
 *  This is the fix for Bug 1: list items are discrete child nodes in storage
 *  already — the old `blockText` walk just joined them with "". Here each
 *  item becomes its own line, so boundaries survive. */
function mdList(list: PMNode, depth = 0): string {
  const ordered = list.type === "orderedList";
  const start =
    typeof list.attrs?.start === "number" ? (list.attrs.start as number) : 1;
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  (list.content ?? []).forEach((item, i) => {
    const marker = ordered ? `${start + i}. ` : "- ";
    const nested: string[] = [];
    let firstLine = "";
    for (const child of item.content ?? []) {
      if (child.type === "bulletList" || child.type === "orderedList") {
        nested.push(mdList(child, depth + 1));
      } else if (firstLine === "") {
        firstLine = mdInline(child.content);
      }
    }
    // A SuperDoc-derived block is ONE item, its depth rebuilt as wrapper
    // items with no text of their own (src/superdoc/extract.ts listNode) —
    // those wrappers carry nesting only, so they get no empty "- " line.
    if (firstLine !== "" || nested.length === 0) lines.push(indent + marker + firstLine);
    if (nested.length) lines.push(...nested);
  });
  return lines.join("\n");
}

/** table → GFM pipe table (first row as header — GFM has no headerless
 *  form). A cell's blocks join with <br> so each row stays on one line. */
function mdTable(table: PMNode): string {
  const rows = (table.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      (cell.content ?? [])
        .map((b) => mdInline(b.content) || blockText(b))
        .join("<br>")
        .replace(/\|/g, "\\|"),
    ),
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) =>
    "| " + [...cells, ...Array<string>(width - cells.length).fill("")].join(" | ") + " |";
  return [line(rows[0]), line(Array<string>(width).fill("---")), ...rows.slice(1).map(line)].join(
    "\n",
  );
}

/**
 * Serialize one top-level block's ProseMirror JSON to markdown — the
 * Claude-facing fix for Bug 2 (formatting never reached Claude) that also
 * fixes Bug 1 for free (list items are rendered one per line instead of
 * flattened). Covers the confirmed block types (paragraph, heading,
 * bulletList, orderedList) plus bold/italic marks; anything else falls back
 * to the flattened `blockText` so an unrecognized node still reads as text
 * rather than throwing.
 */
function blockMarkdown(content: unknown): string {
  const node = content as PMNode | null;
  if (!node || typeof node !== "object") return "";
  switch (node.type) {
    case "heading": {
      const level =
        typeof node.attrs?.level === "number" ? (node.attrs.level as number) : 1;
      return "#".repeat(level) + " " + mdInline(node.content);
    }
    case "bulletList":
    case "orderedList":
      return mdList(node);
    case "paragraph":
      return mdInline(node.content);
    case "table":
      return mdTable(node);
    default:
      return mdInline(node.content) || blockText(content);
  }
}

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

export const listDocumentsForUser = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    return (await readableDocs(ctx, userId)).map(({ doc, role }) => ({
      id: doc._id,
      title: doc.title,
      shared: role === "editor",
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    }));
  },
});

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
  args: { userId: v.string(), documentId: v.id("documents") },
  handler: async (ctx, { userId, documentId }) => {
    const access = await resolveAccessForUser(ctx, documentId, userId);
    if (!access) return null;
    const { doc } = access;

    const blocks = (await liveBlocks(ctx, documentId)).map((b) => ({
      blockId: b.blockId,
      type: b.type,
      author: authorOf(b),
      text: blockMarkdown(decodeContent(b.content)),
    }));

    return { id: doc._id, title: doc.title, updatedAt: doc.updatedAt, blocks };
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

    const visit = await ctx.db
      .query("visits")
      .withIndex("by_doc_user", (q) =>
        q.eq("documentId", documentId).eq("userId", watermark),
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
        author: authorOf(b),
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
    const existing = await ctx.db
      .query("visits")
      .withIndex("by_doc_user", (q) =>
        q.eq("documentId", documentId).eq("userId", watermark),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { lastVisitedAt: now });
    } else {
      await ctx.db.insert("visits", {
        documentId,
        userId: watermark,
        lastVisitedAt: now,
      });
    }
    return now;
  },
});
