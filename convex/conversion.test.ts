// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { STALE_CONVERSION_MS } from "./conversion";

const modules = import.meta.glob("./**/*.*s");
const NAE = { subject: "user_nae" };

const paragraph = (text: string) =>
  JSON.stringify({ type: "paragraph", content: [{ type: "text", text }] });

async function setup() {
  const t = convexTest(schema, modules);
  const updatedAt = 1_000;
  const documentId = await t.run(async (ctx) => {
    const documentId = await ctx.db.insert("documents", {
      ownerId: NAE.subject,
      title: "Test",
      createdAt: 1,
      updatedAt,
    });
    const row = { documentId, createdAt: 10, lastEditedAt: 20 };
    await ctx.db.insert("blocks", {
      ...row,
      blockId: "p1",
      order: 0,
      type: "paragraph",
      content: paragraph("Cleo wrote this"),
      author: "claude",
      authorName: "Cleo",
      previousContent: paragraph("Cleo wrote"),
    });
    await ctx.db.insert("blocks", {
      ...row,
      blockId: "list",
      order: 1,
      type: "bulletList",
      content: "{}",
      author: NAE.subject,
      authorName: "Nae",
    });
    await ctx.db.insert("blocks", {
      ...row,
      blockId: "gone",
      order: 2,
      type: "paragraph",
      content: paragraph("deleted"),
      deletedAt: 30,
    });
    return documentId;
  });
  const nae = t.withIdentity(NAE);
  const seedRoom = () =>
    t.run(async (ctx) => {
      await ctx.db.insert("ydocRooms", {
        documentId,
        claimedBy: NAE.subject,
        claimToken: "tok",
        claimedAt: Date.now(),
        pendingUpdates: 1,
        compactionScheduled: false,
      });
      await ctx.db.insert("ydocUpdates", {
        documentId,
        update: new ArrayBuffer(4),
        author: NAE.subject,
      });
    });
  const converted = [
    { blockId: "sd1", type: "paragraph", content: paragraph("Cleo wrote this"), from: "p1" },
    { blockId: "sd2", type: "bulletList", content: "{}", from: "list" },
    { blockId: "sd3", type: "bulletList", content: "{}", from: "list" },
  ];
  const blocks = () =>
    t.run((ctx) =>
      ctx.db
        .query("blocks")
        .withIndex("by_document", (q) => q.eq("documentId", documentId))
        .collect(),
    );
  return { t, nae, documentId, updatedAt, seedRoom, converted, blocks };
}

describe("conversion.finish", () => {
  it("switches the document, keeping authorship, tombstones and a legacy copy", async () => {
    const { t, nae, documentId, updatedAt, seedRoom, converted, blocks } = await setup();
    await seedRoom();
    await nae.mutation(api.conversion.finish, { documentId, basedOn: updatedAt, blocks: converted });

    const doc = await t.run((ctx) => ctx.db.get(documentId));
    expect(doc?.editor).toBe("superdoc");
    expect(doc?.updatedAt).toBe(updatedAt);

    const rows = await blocks();
    const byId = new Map(rows.map((r) => [r.blockId, r]));
    expect([...byId.keys()].sort()).toEqual(["gone", "sd1", "sd2", "sd3"]);
    expect(byId.get("sd1")).toMatchObject({ author: "claude", authorName: "Cleo", createdAt: 10, lastEditedAt: 20 });
    expect(byId.get("sd1")?.previousContent).toBe(paragraph("Cleo wrote"));
    // A list split into several blocks: author carried, "before" text dropped.
    expect(byId.get("sd3")?.author).toBe(NAE.subject);
    expect(byId.get("sd3")?.previousContent).toBeUndefined();
    expect(byId.get("gone")?.deletedAt).toBe(30);

    const legacy = await t.run((ctx) => ctx.db.query("legacyBlocks").collect());
    expect(legacy.map((r) => r.blockId).sort()).toEqual(["gone", "list", "p1"]);
  });

  it("refuses when a TipTap tab saved after the content was read", async () => {
    const { nae, documentId, updatedAt, seedRoom, converted } = await setup();
    await seedRoom();
    await expect(
      nae.mutation(api.conversion.finish, { documentId, basedOn: updatedAt - 1, blocks: converted }),
    ).rejects.toThrow(/CHANGED_DURING_CONVERSION/);
  });

  it("refuses when nothing reached the room", async () => {
    const { nae, documentId, updatedAt, converted } = await setup();
    await expect(
      nae.mutation(api.conversion.finish, { documentId, basedOn: updatedAt, blocks: converted }),
    ).rejects.toThrow(/NO_CONTENT/);
  });

  it("reverts to the exact TipTap rows", async () => {
    const { t, nae, documentId, updatedAt, seedRoom, converted, blocks } = await setup();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const before = (await blocks()).map(({ _id, _creationTime, ...r }) => r);
    await seedRoom();
    await nae.mutation(api.conversion.finish, { documentId, basedOn: updatedAt, blocks: converted });
    await t.mutation(internal.conversion.revert, { documentId });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const after = (await blocks()).map(({ _id, _creationTime, ...r }) => r);
    const key = (r: { blockId: string }) => r.blockId;
    expect(after.sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
      before.sort((a, b) => key(a).localeCompare(key(b))),
    );
    const doc = await t.run((ctx) => ctx.db.get(documentId));
    expect(doc?.editor).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("ydocUpdates").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("legacyBlocks").collect())).toEqual([]);
  });
});

describe("conversion.prepare / fail", () => {
  it("waits for another tab's live conversion, then clears it once stale", async () => {
    const { t, nae, documentId, seedRoom } = await setup();
    await seedRoom();
    expect(await nae.mutation(api.conversion.prepare, { documentId, claimToken: "tok" })).toBe("ready");
    expect(await nae.mutation(api.conversion.prepare, { documentId, claimToken: "other" })).toBe("busy");

    await t.run(async (ctx) => {
      const room = (await ctx.db.query("ydocRooms").first())!;
      await ctx.db.patch(room._id, { claimedAt: Date.now() - STALE_CONVERSION_MS - 1 });
    });
    expect(await nae.mutation(api.conversion.prepare, { documentId, claimToken: "other" })).toBe("ready");
    expect(await t.run((ctx) => ctx.db.query("ydocRooms").collect())).toEqual([]);
  });

  it("records a failure, drops the room, and stops retrying", async () => {
    const { t, nae, documentId, seedRoom } = await setup();
    await seedRoom();
    await nae.mutation(api.conversion.fail, { documentId, reason: "text mismatch" });
    const doc = await t.run((ctx) => ctx.db.get(documentId));
    expect(doc?.conversionFailure?.reason).toBe("text mismatch");
    expect(await t.run((ctx) => ctx.db.query("ydocUpdates").collect())).toEqual([]);
    expect(await nae.mutation(api.conversion.prepare, { documentId, claimToken: "x" })).toBe("failed");
  });
});
