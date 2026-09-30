// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import * as Y from "yjs";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { COMPACT_AT, INLINE_SNAPSHOT_MAX_BYTES, MAX_UPDATE_BYTES, STALE_CLAIM_MS } from "./ydoc";

const modules = import.meta.glob("./**/*.*s");
const newTest = () => convexTest(schema, modules);

const ALICE = { subject: "user_alice" };
const MALLORY = { subject: "user_mallory" };

const toBuffer = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** Each call returns one Yjs update that inserts `text` at the end. */
function typist() {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on("update", (u: Uint8Array) => updates.push(u));
  return (text: string) => {
    doc.getText("t").insert(doc.getText("t").length, text);
    return toBuffer(updates.at(-1)!);
  };
}

describe("convex/ydoc", () => {
  let t: ReturnType<typeof newTest>;
  let documentId: Id<"documents">;

  beforeEach(async () => {
    vi.useFakeTimers();
    t = newTest();
    documentId = await t.run((ctx) =>
      ctx.db.insert("documents", {
        ownerId: ALICE.subject,
        title: "Test",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const alice = () => t.withIdentity(ALICE);

  /** Every stored row, rebuilt into a fresh doc's text — what a new client sees. */
  async function textFromServer(): Promise<string> {
    const parts = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("ydocUpdates")
        .withIndex("by_document", (q) => q.eq("documentId", documentId))
        .collect();
      // t.run results must be Convex values: ArrayBuffer, not Uint8Array.
      return Promise.all(
        rows.map(async (r) =>
          r.update ?? (await (await ctx.storage.get(r.storageId!))!.arrayBuffer()),
        ),
      );
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.mergeUpdates(parts.map((p) => new Uint8Array(p))));
    return doc.getText("t").toString();
  }

  describe("claimRoom", () => {
    it("creates once, makes a concurrent opener wait, then everyone joins", async () => {
      expect(await alice().mutation(api.ydoc.claimRoom, { documentId })).toBe("create");
      // Second tab before the first has written anything.
      expect(await alice().mutation(api.ydoc.claimRoom, { documentId })).toBe("wait");
      await alice().mutation(api.ydoc.push, { documentId, update: typist()("hi") });
      expect(await alice().mutation(api.ydoc.claimRoom, { documentId })).toBe("join");
    });

    it("lets a stale, never-written claim be taken over", async () => {
      await alice().mutation(api.ydoc.claimRoom, { documentId });
      vi.advanceTimersByTime(STALE_CLAIM_MS + 1);
      expect(await alice().mutation(api.ydoc.claimRoom, { documentId })).toBe("create");
    });

    it("refuses someone without access", async () => {
      await expect(
        t.withIdentity(MALLORY).mutation(api.ydoc.claimRoom, { documentId }),
      ).rejects.toThrow("Not found");
    });
  });

  describe("push / head / since", () => {
    it("returns only rows after the given time, oldest first", async () => {
      await alice().mutation(api.ydoc.claimRoom, { documentId });
      const type = typist();
      await alice().mutation(api.ydoc.push, { documentId, update: type("a") });
      vi.advanceTimersByTime(5);
      await alice().mutation(api.ydoc.push, { documentId, update: type("b") });

      const all = (await alice().query(api.ydoc.since, { documentId, after: 0 }))!;
      expect(all).toHaveLength(2);
      expect(all[0].createdAt).toBeLessThan(all[1].createdAt);

      const later = (await alice().query(api.ydoc.since, { documentId, after: all[0].createdAt }))!;
      expect(later.map((r) => r.id)).toEqual([all[1].id]);

      const head = await alice().query(api.ydoc.head, { documentId });
      expect(head).toEqual({ latest: all[1].createdAt, count: 2 });
    });

    it("hides everything from someone without access", async () => {
      await alice().mutation(api.ydoc.claimRoom, { documentId });
      await alice().mutation(api.ydoc.push, { documentId, update: typist()("secret") });
      const mallory = t.withIdentity(MALLORY);
      expect(await mallory.query(api.ydoc.head, { documentId })).toBeNull();
      expect(await mallory.query(api.ydoc.since, { documentId, after: 0 })).toBeNull();
      await expect(
        mallory.mutation(api.ydoc.push, { documentId, update: typist()("x") }),
      ).rejects.toThrow("Not found");
    });

    it("rejects oversized updates and pushes without a room", async () => {
      await expect(
        alice().mutation(api.ydoc.push, { documentId, update: typist()("x") }),
      ).rejects.toThrow(/NO_ROOM/);
      await alice().mutation(api.ydoc.claimRoom, { documentId });
      await expect(
        alice().mutation(api.ydoc.push, {
          documentId,
          update: new ArrayBuffer(MAX_UPDATE_BYTES + 1),
        }),
      ).rejects.toThrow(/UPDATE_TOO_LARGE/);
    });
  });

  describe("compaction", () => {
    it(`merges ${COMPACT_AT} updates into one inline snapshot without losing text`, async () => {
      await alice().mutation(api.ydoc.claimRoom, { documentId });
      const type = typist();
      let expected = "";
      for (let i = 0; i < COMPACT_AT; i++) {
        const chunk = `w${i} `;
        expected += chunk;
        await alice().mutation(api.ydoc.push, { documentId, update: type(chunk) });
      }
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const rows = await t.run((ctx) =>
        ctx.db
          .query("ydocUpdates")
          .withIndex("by_document", (q) => q.eq("documentId", documentId))
          .collect(),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].author).toBe("compaction");
      expect(rows[0].update).toBeDefined();
      expect(await textFromServer()).toBe(expected);

      const room = await t.run((ctx) =>
        ctx.db
          .query("ydocRooms")
          .withIndex("by_document", (q) => q.eq("documentId", documentId))
          .unique(),
      );
      expect(room).toMatchObject({ pendingUpdates: 0, compactionScheduled: false });
    });

    it("moves a snapshot too big for a row into file storage", async () => {
      await alice().mutation(api.ydoc.claimRoom, { documentId });
      const type = typist();
      const chunk = "x".repeat(Math.ceil(INLINE_SNAPSHOT_MAX_BYTES / COMPACT_AT) + 500);
      for (let i = 0; i < COMPACT_AT; i++) {
        await alice().mutation(api.ydoc.push, { documentId, update: type(chunk) });
      }
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const rows = await t.run((ctx) =>
        ctx.db
          .query("ydocUpdates")
          .withIndex("by_document", (q) => q.eq("documentId", documentId))
          .collect(),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].storageId).toBeDefined();
      expect(rows[0].update).toBeUndefined();
      expect(await textFromServer()).toBe(chunk.repeat(COMPACT_AT));

      // A second round folds the stored snapshot in and deletes its blob.
      for (let i = 0; i < COMPACT_AT; i++) {
        await alice().mutation(api.ydoc.push, { documentId, update: type("y") });
      }
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const blobs = await t.run((ctx) => ctx.db.system.query("_storage").collect());
      expect(blobs).toHaveLength(1);
      expect(await textFromServer()).toBe(chunk.repeat(COMPACT_AT) + "y".repeat(COMPACT_AT));
    });

    it("keeps rows pushed after compaction loaded its input", async () => {
      await alice().mutation(api.ydoc.claimRoom, { documentId });
      const type = typist();
      await alice().mutation(api.ydoc.push, { documentId, update: type("a") });
      const loaded = await t.query(internal.ydoc.loadForCompaction, { documentId });
      await alice().mutation(api.ydoc.push, { documentId, update: type("b") });
      await t.mutation(internal.ydoc.commitCompaction, {
        documentId,
        replaced: loaded.map((r) => r.id),
        update: toBuffer(Y.mergeUpdates(loaded.map((r) => new Uint8Array(r.update!)))),
      });
      expect(await textFromServer()).toBe("ab");
    });
  });

  it("purging a deleted document removes its room, updates and blobs", async () => {
    await alice().mutation(api.ydoc.claimRoom, { documentId });
    const type = typist();
    const chunk = "z".repeat(Math.ceil(INLINE_SNAPSHOT_MAX_BYTES / COMPACT_AT) + 500);
    for (let i = 0; i < COMPACT_AT; i++) {
      await alice().mutation(api.ydoc.push, { documentId, update: type(chunk) });
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.run((ctx) => ctx.db.patch(documentId, { deletedAt: 0 }));

    await t.mutation(internal.documents.purgeDeleted, {});

    const left = await t.run(async (ctx) => ({
      updates: await ctx.db.query("ydocUpdates").collect(),
      rooms: await ctx.db.query("ydocRooms").collect(),
      blobs: await ctx.db.system.query("_storage").collect(),
    }));
    expect(left).toEqual({ updates: [], rooms: [], blobs: [] });
  });
});
