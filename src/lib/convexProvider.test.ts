import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { Id } from "../../convex/_generated/dataModel";
import { attachConvexSync, OVERLAP_MS, PUSH_DEBOUNCE_MS, type SyncClient } from "./convexProvider";

const DOC = "doc1" as Id<"documents">;

type Row = { id: string; createdAt: number; update: ArrayBuffer | null; url: string | null };

/** In-memory stand-in for convex/ydoc.ts: an update log plus `head` subscribers. */
class FakeServer {
  rows: Row[] = [];
  clock = 100_000;
  failPushes = 0;
  heads = new Set<(h: { latest: number | null; count: number }) => void>();
  private seq = 0;

  insert(update: ArrayBuffer | null, opts: { createdAt?: number; url?: string } = {}) {
    this.clock += 10;
    this.rows.push({
      id: `r${this.seq++}`,
      createdAt: opts.createdAt ?? this.clock,
      update,
      url: opts.url ?? null,
    });
    this.rows.sort((a, b) => a.createdAt - b.createdAt);
    this.notify();
  }
  latest() {
    return this.rows.length ? Math.max(...this.rows.map((r) => r.createdAt)) : null;
  }
  notify() {
    const h = { latest: this.latest(), count: this.rows.length };
    for (const cb of this.heads) queueMicrotask(() => cb(h));
  }
  text() {
    const doc = new Y.Doc();
    for (const r of this.rows) if (r.update) Y.applyUpdate(doc, new Uint8Array(r.update));
    return doc.getText("t").toString();
  }
}

/** A fake ConvexClient talking to `server`. */
function fakeClient(server: FakeServer) {
  let closed = false;
  const fake = {
    get closed() {
      return closed;
    },
    onUpdate(
      _q: unknown,
      _args: unknown,
      cb: (h: { latest: number | null; count: number }) => void,
    ) {
      server.heads.add(cb);
      queueMicrotask(() => cb({ latest: server.latest(), count: server.rows.length }));
      return () => void server.heads.delete(cb);
    },
    async query(q: FunctionReference<"query">, args: { after: number }) {
      expect(getFunctionName(q)).toBe("ydoc:since");
      return server.rows.filter((r) => r.createdAt > args.after);
    },
    async mutation(m: FunctionReference<"mutation">, args: { update: ArrayBuffer }) {
      expect(getFunctionName(m)).toBe("ydoc:push");
      if (server.failPushes > 0) {
        server.failPushes--;
        throw new Error("network down");
      }
      server.insert(args.update);
    },
    subscribeToConnectionState() {
      return () => {};
    },
    async close() {
      closed = true;
    },
  };
  return fake as typeof fake & SyncClient;
}

const callbacks = () => ({ onSynced: vi.fn(), onDegraded: vi.fn(), onFailed: vi.fn() });
const type = (doc: Y.Doc, text: string) => doc.getText("t").insert(doc.getText("t").length, text);
/** Let microtasks (subscriptions, awaited queries) and due timers run. */
const settle = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
};

describe("attachConvexSync", () => {
  let server: FakeServer;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    server = new FakeServer();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("syncs edits between two editors without echoing them back", async () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const cbA = callbacks();
    attachConvexSync({ client: fakeClient(server), documentId: DOC, ydoc: a, callbacks: cbA });
    attachConvexSync({ client: fakeClient(server), documentId: DOC, ydoc: b, callbacks: callbacks() });
    await settle();
    expect(cbA.onSynced).toHaveBeenCalledTimes(1);

    type(a, "hello");
    await settle(PUSH_DEBOUNCE_MS);
    await settle();

    expect(b.getText("t").toString()).toBe("hello");
    expect(server.rows).toHaveLength(1); // B applied it without pushing it back
  });

  it("loads existing content before reporting synced", async () => {
    const seed = new Y.Doc();
    seed.on("update", (u: Uint8Array) => server.insert(u.slice().buffer));
    type(seed, "already here");

    const doc = new Y.Doc();
    const cb = callbacks();
    attachConvexSync({ client: fakeClient(server), documentId: DOC, ydoc: doc, callbacks: cb });
    await settle();
    expect(cb.onSynced).toHaveBeenCalled();
    expect(doc.getText("t").toString()).toBe("already here");
  });

  it("pushes edits made before the first pull finished", async () => {
    const doc = new Y.Doc();
    attachConvexSync({ client: fakeClient(server), documentId: DOC, ydoc: doc, callbacks: callbacks() });
    type(doc, "early"); // before any microtask has run
    await settle();
    await settle(PUSH_DEBOUNCE_MS);
    expect(server.text()).toBe("early");
  });

  it("retries a failed push, keeps edit order, and reports recovery", async () => {
    const doc = new Y.Doc();
    const cb = callbacks();
    attachConvexSync({ client: fakeClient(server), documentId: DOC, ydoc: doc, callbacks: cb });
    await settle();

    server.failPushes = 1;
    type(doc, "one ");
    await settle(PUSH_DEBOUNCE_MS);
    expect(server.rows).toHaveLength(0);
    expect(cb.onDegraded).toHaveBeenCalledTimes(1);

    type(doc, "two"); // queued behind the failed batch
    await settle(2_000 + PUSH_DEBOUNCE_MS);
    await settle(PUSH_DEBOUNCE_MS);
    expect(server.text()).toBe("one two");
    expect(cb.onSynced).toHaveBeenCalledTimes(2); // initial + recovery
    expect(cb.onFailed).not.toHaveBeenCalled();
  });

  it("sends pending edits before closing", async () => {
    const doc = new Y.Doc();
    const client = fakeClient(server);
    const sync = attachConvexSync({ client, documentId: DOC, ydoc: doc, callbacks: callbacks() });
    await settle();

    type(doc, "last words"); // debounce hasn't fired yet
    await sync.destroy();
    expect(server.text()).toBe("last words");
    expect(client.closed).toBe(true);
  });

  it("picks up a row that committed out of timestamp order", async () => {
    const doc = new Y.Doc();
    attachConvexSync({ client: fakeClient(server), documentId: DOC, ydoc: doc, callbacks: callbacks() });
    const other = new Y.Doc();
    const updates: ArrayBuffer[] = [];
    other.on("update", (u: Uint8Array) => updates.push(u.slice().buffer));

    type(other, "first ");
    server.insert(updates[0]);
    await settle();
    const seenUpTo = server.latest()!;

    // A row stamped *before* what we've already seen, landing afterwards.
    type(other, "late");
    server.insert(updates[1], { createdAt: seenUpTo - OVERLAP_MS / 2 });
    await settle();
    expect(doc.getText("t").toString()).toBe("first late");
  });

  it("fetches a snapshot stored as a file", async () => {
    const seed = new Y.Doc();
    type(seed, "from storage");
    const bytes = Y.encodeStateAsUpdate(seed);
    server.insert(null, { url: "https://example.test/snap" });

    const fetchBytes = vi.fn(async () => bytes);
    const doc = new Y.Doc();
    attachConvexSync({
      client: fakeClient(server),
      documentId: DOC,
      ydoc: doc,
      callbacks: callbacks(),
      fetchBytes,
    });
    await settle();
    expect(fetchBytes).toHaveBeenCalledWith("https://example.test/snap");
    expect(doc.getText("t").toString()).toBe("from storage");
  });
});
