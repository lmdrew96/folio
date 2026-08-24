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

/**
 * ONE-TIME: clear a stray content.attrs.fontSize left over from before the
 * font-size/heading fixes (v0.37.x) — it silently locks a block's rendered
 * size at whatever it was when set, regardless of its paragraph/heading
 * style, which is why converting a block to a heading (or clearing/resizing
 * it) looked like it "didn't work." Confirmed via manual audit that this is
 * isolated to Rainbridge (121 of its 123 paragraph/heading blocks), most
 * likely from an old whole-document size-set that predates the fixes. Skips
 * blocks whose fontSize is already unset. Run once via
 *   npx convex run migrations:clearStrayFontSizes
 * Idempotent — a re-run just finds nothing left to clear. Deliberately a
 * direct content.attrs patch (not reconcile()) so it doesn't bump
 * lastEditedAt/previousContent/author — a pure style fix, not an edit.
 */
export const clearStrayFontSizes = internalMutation({
  args: {},
  handler: async (ctx) => {
    const documents = await ctx.db.query("documents").collect();
    let cleared = 0;

    for (const doc of documents) {
      const blocks = await ctx.db
        .query("blocks")
        .withIndex("by_document", (q) => q.eq("documentId", doc._id))
        .collect();

      for (const b of blocks) {
        if (b.deletedAt !== undefined) continue;
        if (b.type !== "paragraph" && b.type !== "heading") continue;

        const content = b.content as { attrs?: Record<string, unknown> } | undefined;
        const fontSize = content?.attrs?.fontSize;
        if (typeof fontSize !== "string" || fontSize.length === 0) continue;

        await ctx.db.patch(b._id, {
          content: { ...content, attrs: { ...content!.attrs, fontSize: null } },
        });
        cleared++;
      }
    }

    return { cleared };
  },
});
