// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.*s");
const ALICE = "user_alice";
const BOB = "user_bob";

const paragraph = (text: string) =>
  JSON.stringify({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });
const heading = (text: string) =>
  JSON.stringify({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });

type Seed = { blockId: string; content: string; type?: string; at?: number };

function setup() {
  const t = convexTest(schema, modules);
  const doc = (ownerId: string, title: string, blocks: Seed[], extra: object = {}) =>
    t.run(async (ctx) => {
      const documentId = await ctx.db.insert("documents", {
        ownerId,
        title,
        createdAt: 1,
        updatedAt: Math.max(1, ...blocks.map((b) => b.at ?? 1)),
        ...extra,
      });
      for (const [i, b] of blocks.entries()) {
        await ctx.db.insert("blocks", {
          documentId,
          blockId: b.blockId,
          order: i,
          type: b.type ?? "paragraph",
          content: b.content,
          author: ownerId,
          authorName: ownerId === ALICE ? "Alice" : "Bob",
          createdAt: b.at ?? 1,
          lastEditedAt: b.at ?? 1,
        });
      }
      return documentId;
    });
  const share = (documentId: Id<"documents">, userId: string) =>
    t.run((ctx) =>
      ctx.db.insert("documentShares", {
        documentId,
        invitedEmail: `${userId}@x.test`,
        userId,
        invitedAt: 1,
        acceptedAt: 1,
      }),
    );
  return { t, doc, share };
}

describe("searchForUser", () => {
  it("finds blocks containing every word, across own and shared documents", async () => {
    const { t, doc, share } = setup();
    await doc(ALICE, "SLA notes", [
      { blockId: "a1", content: paragraph("Krashen's input hypothesis, again") },
      { blockId: "a2", content: paragraph("Nothing to see") },
      { blockId: "a3", content: paragraph("") },
    ]);
    const bobs = await doc(BOB, "Bob's draft", [
      { blockId: "b1", content: paragraph("The input matters more than the hypothesis") },
    ]);
    await doc(BOB, "Bob's private", [{ blockId: "b2", content: paragraph("input hypothesis") }]);
    await share(bobs, ALICE);

    const res = await t.query(internal.mcpData.searchForUser, {
      userId: ALICE,
      query: "Input  HYPOTHESIS",
    });
    expect(res.totalHits).toBe(2);
    // The exact phrase outranks the words appearing apart.
    expect(res.hits.map((h) => h.blockId)).toEqual(["a1", "b1"]);
    expect(res.hits[0]).toMatchObject({
      documentTitle: "SLA notes",
      blockType: "paragraph",
      author: "Alice",
      snippet: "Krashen's input hypothesis, again",
    });
  });

  it("breaks ties by recency, honours limit and trims long snippets", async () => {
    const { t, doc } = setup();
    const long = `${"x ".repeat(200)}needle${" y".repeat(200)}`;
    await doc(ALICE, "One", [
      { blockId: "old", content: paragraph("needle"), at: 10 },
      { blockId: "new", content: paragraph("needle"), at: 20 },
      { blockId: "long", content: paragraph(long), at: 5 },
    ]);
    const res = await t.query(internal.mcpData.searchForUser, {
      userId: ALICE,
      query: "needle",
      limit: 2,
    });
    expect(res.totalHits).toBe(3);
    expect(res.hits.map((h) => h.blockId)).toEqual(["new", "old"]);

    const all = await t.query(internal.mcpData.searchForUser, { userId: ALICE, query: "needle" });
    const snippet = all.hits.find((h) => h.blockId === "long")!.snippet;
    expect(snippet.length).toBeLessThanOrEqual(162);
    expect(snippet).toMatch(/^….*needle.*…$/);
  });

  it("ranks headings above body text and skips trashed documents", async () => {
    const { t, doc } = setup();
    await doc(ALICE, "Live", [
      { blockId: "p", content: paragraph("Phonology") },
      { blockId: "h", content: heading("Phonology"), type: "heading" },
    ]);
    await doc(ALICE, "Trashed", [{ blockId: "t", content: paragraph("Phonology") }], {
      deletedAt: 5,
    });
    const res = await t.query(internal.mcpData.searchForUser, {
      userId: ALICE,
      query: "phonology",
    });
    expect(res.hits.map((h) => h.blockId)).toEqual(["h", "p"]);
  });

  it("rejects an empty query", async () => {
    const { t } = setup();
    await expect(
      t.query(internal.mcpData.searchForUser, { userId: ALICE, query: "   " }),
    ).rejects.toThrow(/non-empty/);
  });
});

describe("whatsNewForUser / markAllVisitedForUser", () => {
  const WM = "mcp:key1";

  it("counts changes per document, flags never-looked, omits unchanged", async () => {
    const { t, doc } = setup();
    const seen = await doc(ALICE, "Seen, changed", [
      { blockId: "old", content: paragraph("old"), at: 10 },
    ]);
    const quiet = await doc(ALICE, "Seen, quiet", [{ blockId: "q", content: paragraph("q"), at: 10 }]);
    await doc(ALICE, "Never looked", [{ blockId: "n", content: paragraph("n"), at: 10 }]);
    await t.run(async (ctx) => {
      for (const documentId of [seen, quiet]) {
        await ctx.db.insert("visits", { documentId, userId: WM, lastVisitedAt: 50 });
      }
      // After the watermark: one edit, one add, one delete.
      const [old] = await ctx.db
        .query("blocks")
        .withIndex("by_document_block", (q) => q.eq("documentId", seen).eq("blockId", "old"))
        .collect();
      await ctx.db.patch(old._id, { lastEditedAt: 60 });
      await ctx.db.insert("blocks", {
        documentId: seen, blockId: "new", order: 1, type: "paragraph",
        content: paragraph("new"), createdAt: 70, lastEditedAt: 70,
      });
      await ctx.db.insert("blocks", {
        documentId: seen, blockId: "gone", order: 2, type: "paragraph",
        content: paragraph("gone"), createdAt: 1, lastEditedAt: 1, deletedAt: 80,
      });
      await ctx.db.patch(seen, { updatedAt: 80 });
    });

    const { documents } = await t.query(internal.mcpData.whatsNewForUser, {
      userId: ALICE,
      watermark: WM,
    });
    expect(documents).toEqual([
      {
        documentId: seen, title: "Seen, changed", updatedAt: 80, hasWatermark: true,
        addedCount: 1, editedCount: 1, deletedCount: 1,
      },
      expect.objectContaining({ title: "Never looked", hasWatermark: false, addedCount: null }),
    ]);
  });

  it("marks every readable document caught up for this key only", async () => {
    const { t, doc } = setup();
    await doc(ALICE, "A", [{ blockId: "a", content: paragraph("a"), at: 10 }]);
    await doc(ALICE, "B", [{ blockId: "b", content: paragraph("b"), at: 10 }]);
    await doc(BOB, "Not mine", [{ blockId: "c", content: paragraph("c"), at: 10 }]);

    const res = await t.mutation(internal.mcpData.markAllVisitedForUser, {
      userId: ALICE,
      watermark: WM,
    });
    expect(res.documents).toBe(2);
    const after = await t.query(internal.mcpData.whatsNewForUser, { userId: ALICE, watermark: WM });
    expect(after.documents).toEqual([]);
    const otherKey = await t.query(internal.mcpData.whatsNewForUser, {
      userId: ALICE,
      watermark: "mcp:key2",
    });
    expect(otherKey.documents).toHaveLength(2);
  });
});
