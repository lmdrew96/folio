import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { resolveAccess } from "./access";

/**
 * v1 continuity layer. A real, two-sided conversation with Cleo per document —
 * replaces `reactions`' one-shot, paraphrase-based "memory" (see identity.ts's
 * old priorSection) with actual turn history sent to the model. `send` is a
 * collaborator's free-text turn; `recordReply` is Cleo's, either a `"chat"`
 * answer or a `"reaction"` to a diff-since-last-look (same shape `reactions`
 * rows had). One shared thread per document — every collaborator with access
 * sees and adds to the same conversation.
 */

// How many messages per document `purgeOld` keeps.
const MESSAGES_KEEP = 200;

/** A collaborator's free-text turn. Owner-or-editor gated. */
export const send = mutation({
  args: { documentId: v.id("documents"), content: v.string() },
  handler: async (ctx, { documentId, content }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access) throw new Error("Not found");

    const trimmed = content.trim();
    if (!trimmed) throw new Error("Message is empty");

    const account = await ctx.db
      .query("users")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .unique();

    return await ctx.db.insert("messages", {
      documentId,
      author: identity.subject,
      authorName: account?.displayName,
      kind: "chat",
      content: trimmed,
      createdAt: Date.now(),
    });
  },
});

/**
 * Persist Cleo's reply once a stream completes — either a `"chat"` answer or
 * a `"reaction"` to what changed (summary set only for the latter). Called
 * server-side from the API route, never from the client directly.
 */
export const recordReply = mutation({
  args: {
    documentId: v.id("documents"),
    content: v.string(),
    kind: v.union(v.literal("chat"), v.literal("reaction")),
    summary: v.optional(v.string()),
  },
  handler: async (ctx, { documentId, content, kind, summary }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access) throw new Error("Not found");

    // Don't persist empty/whitespace-only replies (e.g. a stream that errored
    // out before producing text) — they'd pollute the conversation history.
    if (content.trim().length === 0) return null;

    return await ctx.db.insert("messages", {
      documentId,
      author: "claude",
      kind,
      content,
      summary,
      createdAt: Date.now(),
    });
  },
});

/**
 * Full conversation for a document, oldest → newest (reading order). Reactive
 * for the UI; also fetched one-shot (via ConvexHttpClient) when the API route
 * builds the Anthropic call.
 */
export const history = query({
  args: { documentId: v.id("documents"), limit: v.optional(v.number()) },
  handler: async (ctx, { documentId, limit }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const access = await resolveAccess(ctx, documentId, identity);
    if (!access) return [];

    const rows = await ctx.db
      .query("messages")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();

    return rows
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-(limit ?? 200))
      .map((m) => ({
        id: m._id,
        author: m.author,
        authorName: m.authorName,
        kind: m.kind,
        content: m.content,
        summary: m.summary,
        createdAt: m.createdAt,
      }));
  },
});

/**
 * Cap stored messages per document to the most recent MESSAGES_KEEP — mirrors
 * reactions.purgeOld exactly. Runs on a weekly cron (convex/crons.ts).
 */
export const purgeOld = internalMutation({
  args: {},
  handler: async (ctx) => {
    const documents = await ctx.db.query("documents").collect();

    for (const doc of documents) {
      const rows = await ctx.db
        .query("messages")
        .withIndex("by_document", (q) => q.eq("documentId", doc._id))
        .collect();
      if (rows.length <= MESSAGES_KEEP) continue;

      const excess = rows
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(MESSAGES_KEEP);
      await Promise.all(excess.map((m) => ctx.db.delete(m._id)));
    }
  },
});
