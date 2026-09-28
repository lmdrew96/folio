import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

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

/**
 * ONE-TIME: moving from the Clerk development instance to production gives
 * every account a new user id, and imported data still carries the old ones.
 * Run once on prod, right after importing the dev snapshot:
 *   npx convex run --prod migrations:remapForProdClerk \
 *     '{"fromUserId":"<dev id>","toUserId":"<prod id>","dryRun":true}'
 * then again without dryRun.
 *
 * - The owner's id (`fromUserId` → `toUserId`) is rewritten everywhere it's
 *   stored: documents/folders owners, block + message authors, visits, the
 *   users row, friends, and resolved shares.
 * - Every OTHER Clerk id is left to re-resolve itself: resolved shares go back
 *   to pending (users.upsertUser re-links them by email on that person's
 *   first prod sign-in), their users rows and watermarks are dropped, and
 *   friends' resolved ids are cleared (upsertUser re-fills them too). Their
 *   block/message authorship keeps its snapshotted authorName, so attribution
 *   still reads right.
 * - Sibling identities ("claude", MCP identities like "coru") aren't Clerk
 *   ids — anything not starting with "user_" is never touched.
 * - Presence is ephemeral and simply cleared.
 *
 * Idempotent: a re-run finds nothing left to change.
 */
export const remapForProdClerk = internalMutation({
  args: { fromUserId: v.string(), toUserId: v.string(), dryRun: v.boolean() },
  handler: async (ctx, { fromUserId, toUserId, dryRun }) => {
    const isClerk = (id: string | undefined): id is string => !!id && id.startsWith("user_");
    const counts: Record<string, number> = {};
    const bump = (key: string) => (counts[key] = (counts[key] ?? 0) + 1);

    for (const d of await ctx.db.query("documents").collect()) {
      if (d.ownerId === fromUserId) {
        bump("documents.ownerId");
        if (!dryRun) await ctx.db.patch(d._id, { ownerId: toUserId });
      } else if (d.ownerId !== toUserId) {
        bump("documents owned by someone else (left alone)");
      }
    }
    for (const f of await ctx.db.query("folders").collect()) {
      if (f.ownerId === fromUserId) {
        bump("folders.ownerId");
        if (!dryRun) await ctx.db.patch(f._id, { ownerId: toUserId });
      }
    }
    for (const b of await ctx.db.query("blocks").collect()) {
      const patch: { author?: string; previouslyDraftedBy?: string } = {};
      if (b.author === fromUserId) patch.author = toUserId;
      if (b.previouslyDraftedBy === fromUserId) patch.previouslyDraftedBy = toUserId;
      if (Object.keys(patch).length) {
        bump("blocks");
        if (!dryRun) await ctx.db.patch(b._id, patch);
      }
    }
    for (const m of await ctx.db.query("messages").collect()) {
      if (m.author === fromUserId) {
        bump("messages.author");
        if (!dryRun) await ctx.db.patch(m._id, { author: toUserId });
      }
    }
    for (const vis of await ctx.db.query("visits").collect()) {
      if (vis.userId === fromUserId) {
        bump("visits (remapped)");
        if (!dryRun) await ctx.db.patch(vis._id, { userId: toUserId });
      } else if (isClerk(vis.userId) && vis.userId !== toUserId) {
        bump("visits (other accounts, dropped)");
        if (!dryRun) await ctx.db.delete(vis._id);
      }
    }
    const users = await ctx.db.query("users").collect();
    // A prod sign-in before the import may already have made a row for the new
    // id — upsertUser's .unique() would throw on two, so drop the old one then.
    const hasNewRow = users.some((u) => u.userId === toUserId);
    for (const u of users) {
      if (u.userId === fromUserId) {
        bump(hasNewRow ? "users (old row dropped, new one exists)" : "users (remapped)");
        if (!dryRun) {
          if (hasNewRow) await ctx.db.delete(u._id);
          else await ctx.db.patch(u._id, { userId: toUserId });
        }
      } else if (u.userId !== toUserId) {
        bump("users (other accounts, dropped)");
        if (!dryRun) await ctx.db.delete(u._id);
      }
    }
    for (const s of await ctx.db.query("documentShares").collect()) {
      if (s.userId === fromUserId) {
        bump("shares (remapped)");
        if (!dryRun) await ctx.db.patch(s._id, { userId: toUserId });
      } else if (isClerk(s.userId) && s.userId !== toUserId) {
        bump("shares (reset to pending)");
        if (!dryRun) {
          await ctx.db.patch(s._id, { userId: undefined, acceptedAt: undefined, displayName: undefined });
        }
      }
    }
    for (const fr of await ctx.db.query("friends").collect()) {
      const patch: { ownerId?: string; friendUserId?: string } = {};
      if (fr.ownerId === fromUserId) patch.ownerId = toUserId;
      if (fr.friendUserId === fromUserId) patch.friendUserId = toUserId;
      else if (isClerk(fr.friendUserId) && fr.friendUserId !== toUserId) patch.friendUserId = undefined;
      if (Object.keys(patch).length) {
        bump("friends");
        if (!dryRun) await ctx.db.patch(fr._id, patch);
      }
    }
    for (const p of await ctx.db.query("presence").collect()) {
      bump("presence (cleared)");
      if (!dryRun) await ctx.db.delete(p._id);
    }

    return { dryRun, counts };
  },
});
