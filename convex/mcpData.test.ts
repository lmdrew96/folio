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

describe("listDocumentsForUser filters / listFoldersForUser", () => {
  async function filed() {
    const { t, doc, share } = setup();
    const ids = await t.run(async (ctx) => {
      const classes = await ctx.db.insert("folders", { ownerId: ALICE, name: "Classes", createdAt: 1 });
      const psych = await ctx.db.insert("folders", {
        ownerId: ALICE, name: "Psycholinguistics", parentId: classes, createdAt: 1,
      });
      const misc = await ctx.db.insert("folders", { ownerId: ALICE, name: "Misc", createdAt: 1 });
      return { classes, psych, misc };
    });
    await doc(ALICE, "Week 1", [{ blockId: "a", content: paragraph("a"), at: 100 }], {
      folderId: ids.psych,
    });
    await doc(ALICE, "Syllabus", [{ blockId: "b", content: paragraph("b"), at: 200 }], {
      folderId: ids.classes,
    });
    await doc(ALICE, "Loose", [{ blockId: "c", content: paragraph("c"), at: 300 }]);
    const bobs = await doc(BOB, "Bob's", [{ blockId: "d", content: paragraph("d"), at: 400 }]);
    await share(bobs, ALICE);
    return { t, ids };
  }

  it("shows each document's folder path; shared documents read as unfiled", async () => {
    const { t, ids } = await filed();
    const docs = await t.query(internal.mcpData.listDocumentsForUser, { userId: ALICE });
    expect(docs.map((d) => [d.title, d.folder?.path ?? null])).toEqual([
      ["Bob's", null],
      ["Loose", null],
      ["Syllabus", "Classes"],
      ["Week 1", "Classes / Psycholinguistics"],
    ]);
    expect(docs[3].folder!.id).toBe(ids.psych);
  });

  it("filters by folder (with subfolders) and by date", async () => {
    const { t, ids } = await filed();
    const inClasses = await t.query(internal.mcpData.listDocumentsForUser, {
      userId: ALICE,
      folderId: ids.classes,
    });
    expect(inClasses.map((d) => d.title)).toEqual(["Syllabus", "Week 1"]);

    const recent = await t.query(internal.mcpData.listDocumentsForUser, {
      userId: ALICE,
      updatedAfter: new Date(200).toISOString(),
      updatedBefore: new Date(300).toISOString(),
    });
    expect(recent.map((d) => d.title)).toEqual(["Loose", "Syllabus"]);

    await expect(
      t.query(internal.mcpData.listDocumentsForUser, { userId: ALICE, updatedAfter: "last week" }),
    ).rejects.toThrow(/ISO 8601/);
    await expect(
      t.query(internal.mcpData.listDocumentsForUser, { userId: BOB, folderId: ids.classes }),
    ).rejects.toThrow(/not found/);
  });

  it("lists the folder tree with paths and direct document counts", async () => {
    const { t } = await filed();
    const { folders } = await t.query(internal.mcpData.listFoldersForUser, { userId: ALICE });
    expect(folders.map((f) => [f.path, f.documentCount])).toEqual([
      ["Classes", 1],
      ["Classes / Psycholinguistics", 1],
      ["Misc", 0],
    ]);
  });
});

describe("readDocumentForUser ranges", () => {
  async function tenBlocks() {
    const { t, doc } = setup();
    const blocks: Seed[] = [];
    for (let i = 0; i < 10; i++) {
      blocks.push({ blockId: `b${i}`, content: paragraph(`line ${i}`) });
      if (i === 4) blocks.push({ blockId: "blank", content: paragraph("") });
    }
    const documentId = await doc(ALICE, "Long", blocks);
    const read = (extra: object = {}) =>
      t.query(internal.mcpData.readDocumentForUser, { userId: ALICE, documentId, ...extra });
    return { read };
  }
  const ids = (r: { blocks: { blockId: string }[] } | null) => r!.blocks.map((b) => b.blockId);

  it("reads everything but empty blocks by default", async () => {
    const { read } = await tenBlocks();
    const r = await read();
    expect(r!.totalBlocks).toBe(10);
    expect(r!.emptyBlocksOmitted).toBe(1);
    expect(ids(r)).not.toContain("blank");
    expect(r).not.toHaveProperty("hasMoreAfter");
    expect(ids(await read({ includeEmpty: true }))).toContain("blank");
  });

  it("reads forward from a block", async () => {
    const { read } = await tenBlocks();
    const r = await read({ fromBlockId: "b3", limit: 3 });
    expect(ids(r)).toEqual(["b3", "b4", "b5"]);
    expect(r).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });
    const tail = await read({ fromBlockId: "b8", limit: 50 });
    expect(ids(tail)).toEqual(["b8", "b9"]);
    expect(tail!.hasMoreAfter).toBe(false);
  });

  it("reads around a block, clamped at the edges", async () => {
    const { read } = await tenBlocks();
    expect(ids(await read({ aroundBlockId: "b5", context: 1 }))).toEqual(["b4", "b5", "b6"]);
    const head = await read({ aroundBlockId: "b0", context: 2 });
    expect(ids(head)).toEqual(["b0", "b1", "b2"]);
    expect(head!.hasMoreBefore).toBe(false);
  });

  it("rejects an unknown anchor or both anchors at once", async () => {
    const { read } = await tenBlocks();
    await expect(read({ fromBlockId: "nope" })).rejects.toThrow(/not found/);
    await expect(read({ fromBlockId: "b1", aroundBlockId: "b2" })).rejects.toThrow(/not both/);
  });
});
