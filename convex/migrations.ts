import { internalMutation } from "./_generated/server";

/**
 * ONE-TIME: sharing (v0.20.0) moved the diff/Cleo-reaction watermark from the
 * literal userId "nae" to the real Clerk subject, so pre-sharing `visits`
 * rows keyed "nae" are now orphaned — no query ever looks them up again, but
 * they still count toward purgeOldTombstones' `Math.min` over a document's
 * watermarks, permanently pinning what that cron can purge. Deletes them.
 * Run once via
 *   npx convex run migrations:deleteStaleNaeVisits
 * Idempotent — a re-run just finds nothing.
 */
export const deleteStaleNaeVisits = internalMutation({
  args: {},
  handler: async (ctx) => {
    const documents = await ctx.db.query("documents").collect();
    let deleted = 0;

    for (const doc of documents) {
      const visits = await ctx.db
        .query("visits")
        .withIndex("by_doc_user", (q) =>
          q.eq("documentId", doc._id).eq("userId", "nae"),
        )
        .collect();
      for (const v of visits) {
        await ctx.db.delete(v._id);
        deleted++;
      }
    }

    return { deleted };
  },
});

/**
 * ONE-TIME: copy existing `reactions` rows into `messages` as claude-authored,
 * kind:"reaction" rows, so the new unified conversation view opens with Cleo's
 * prior commentary instead of a blank thread. Run once via
 *   npx convex run migrations:backfillReactionsToMessages
 * Idempotent — skips a reaction if a message with the same documentId,
 * createdAt, and content already exists, so a re-run (or a partial failure)
 * is harmless.
 */
export const backfillReactionsToMessages = internalMutation({
  args: {},
  handler: async (ctx) => {
    const reactions = await ctx.db.query("reactions").collect();
    let inserted = 0;

    for (const r of reactions) {
      const existing = await ctx.db
        .query("messages")
        .withIndex("by_document", (q) => q.eq("documentId", r.documentId))
        .collect();
      const dup = existing.some(
        (m) => m.createdAt === r.createdAt && m.content === r.content,
      );
      if (dup) continue;

      await ctx.db.insert("messages", {
        documentId: r.documentId,
        author: "claude",
        kind: "reaction",
        content: r.content,
        summary: r.summary,
        createdAt: r.createdAt,
      });
      inserted++;
    }

    return { total: reactions.length, inserted };
  },
});
