// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.*s");
const ALICE = { subject: "user_alice" };

const paragraph = (text: string) =>
  JSON.stringify({ type: "paragraph", content: [{ type: "text", text }] });

describe("blocks.reconcile editor guard", () => {
  async function setup(editor?: "superdoc") {
    const t = convexTest(schema, modules);
    const documentId = await t.run((ctx) =>
      ctx.db.insert("documents", {
        ownerId: ALICE.subject,
        title: "Test",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        editor,
      }),
    );
    const write = (source?: "superdoc") =>
      t.withIdentity(ALICE).mutation(api.blocks.reconcile, {
        documentId,
        blocks: [{ blockId: "b1", type: "paragraph", content: paragraph("hi") }],
        source,
      });
    return { write };
  }

  it("lets each editor write its own documents", async () => {
    await expect((await setup()).write()).resolves.toBeNull();
    await expect((await setup("superdoc")).write("superdoc")).resolves.toBeNull();
  });

  it("stops a TipTap tab writing a SuperDoc document's blocks", async () => {
    await expect((await setup("superdoc")).write()).rejects.toThrow(/EDITOR_MISMATCH/);
  });

  it("stops SuperDoc writing a TipTap document's blocks", async () => {
    await expect((await setup()).write("superdoc")).rejects.toThrow(/EDITOR_MISMATCH/);
  });
});
