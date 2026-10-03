// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.*s");
const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };

describe("diff.ensureVisited", () => {
  async function setup() {
    const t = convexTest(schema, modules);
    const documentId = await t.run((ctx) =>
      ctx.db.insert("documents", { ownerId: ALICE.subject, title: "T", createdAt: 1, updatedAt: 1 }),
    );
    const visits = () => t.run((ctx) => ctx.db.query("visits").collect());
    return { t, documentId, visits };
  }

  it("sets a baseline on first open so the diff starts working", async () => {
    const { t, documentId } = await setup();
    const diff = () =>
      t.withIdentity(ALICE).query(api.diff.diffSince, { documentId, userId: ALICE.subject });
    expect((await diff()).hasWatermark).toBe(false);
    await t.withIdentity(ALICE).mutation(api.diff.ensureVisited, { documentId });
    expect((await diff()).hasWatermark).toBe(true);
  });

  it("never moves an existing watermark or touches anyone else's", async () => {
    const { t, documentId, visits } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("visits", { documentId, userId: ALICE.subject, lastVisitedAt: 5 });
      await ctx.db.insert("visits", { documentId, userId: "claude", lastVisitedAt: 6 });
    });
    await t.withIdentity(ALICE).mutation(api.diff.ensureVisited, { documentId });
    expect((await visits()).map((v) => [v.userId, v.lastVisitedAt])).toEqual([
      [ALICE.subject, 5],
      ["claude", 6],
    ]);
  });

  it("does nothing for someone without access", async () => {
    const { t, documentId, visits } = await setup();
    await t.withIdentity(BOB).mutation(api.diff.ensureVisited, { documentId });
    expect(await visits()).toEqual([]);
  });
});

describe("diff.diffSince markdown", () => {
  it("gives added blocks their formatting, dedented, without raw <u> tags", async () => {
    const t = convexTest(schema, modules);
    const documentId = await t.run(async (ctx) => {
      const documentId = await ctx.db.insert("documents", {
        ownerId: ALICE.subject, title: "T", createdAt: 1, updatedAt: 1,
      });
      await ctx.db.insert("visits", { documentId, userId: ALICE.subject, lastVisitedAt: 5 });
      const add = (blockId: string, content: object, order: number) =>
        ctx.db.insert("blocks", {
          documentId, blockId, order, type: (content as { type: string }).type,
          content: JSON.stringify(content), createdAt: 10 + order, lastEditedAt: 10 + order,
        });
      await add("p", {
        type: "paragraph",
        content: [
          { type: "text", text: "bold", marks: [{ type: "bold" }] },
          { type: "text", text: " and " },
          { type: "text", text: "under", marks: [{ type: "underline" }] },
        ],
      }, 1);
      // A SuperDoc-derived item three levels deep.
      let node: object = { type: "paragraph", content: [{ type: "text", text: "deep" }] };
      for (let i = 0; i < 3; i++) {
        node = { type: "bulletList", content: [{ type: "listItem", content: [node] }] };
      }
      await add("l", node, 2);
      return documentId;
    });
    const diff = await t
      .withIdentity(ALICE)
      .query(api.diff.diffSince, { documentId, userId: ALICE.subject });
    const md = Object.fromEntries(diff.added.map((i) => [i.blockId, i.markdown]));
    expect(md.p).toBe("**bold** and under");
    expect(md.l).toBe("- deep");
  });
});
