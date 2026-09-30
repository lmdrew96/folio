import * as Y from "yjs";
import { ConvexError } from "convex/values";
import type { ConvexClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * Keeps one SuperDoc Y.Doc in sync with Convex (convex/ydoc.ts). Runs inside
 * SuperDoc's collaboration worker (collab-worker.ts registers it as the
 * "convex" provider adapter); kept free of worker globals so it can be tested
 * against a fake client.
 *
 * Pull: subscribe to the cheap `head` marker; whenever it moves, fetch only
 * the rows since the last one seen and apply them. The fetch re-reads an
 * OVERLAP_MS window behind that point and dedupes by row id, so a row that
 * commits slightly out of timestamp order is picked up on the next pull
 * instead of being skipped forever. Re-applying a Yjs update is a no-op.
 *
 * Push: local updates are batched for PUSH_DEBOUNCE_MS, merged, and sent one
 * batch at a time. A failed batch goes back to the front of the queue and is
 * retried; errors a retry can't fix are reported as failed.
 */

export const PUSH_DEBOUNCE_MS = 250;
export const OVERLAP_MS = 10_000;
const RETRY_MS = 2_000;
const CLOSE_FLUSH_TIMEOUT_MS = 5_000;

/** The slice of ConvexClient this uses — a fake implements it in tests. */
export type SyncClient = Pick<
  ConvexClient,
  "onUpdate" | "query" | "mutation" | "subscribeToConnectionState" | "close"
>;

export type SyncCallbacks = {
  /** First full pull applied — the room is usable. Called again on recovery. */
  onSynced(): void;
  /** Connection lost or a request failing; local edits are held and retried. */
  onDegraded(): void;
  /** Something a retry can't fix (no access, oversized update). */
  onFailed(detail: Record<string, unknown>): void;
};

export type SyncHandle = { destroy(): Promise<void> };

/** Origin tag for updates applied from the server, so they aren't pushed back. */
const REMOTE = Symbol("convex-remote");

const toArrayBuffer = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

const errorCode = (err: unknown): string | undefined =>
  err instanceof ConvexError ? (err.data as { code?: string } | undefined)?.code : undefined;

const defaultFetchBytes = async (url: string): Promise<Uint8Array> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`snapshot fetch failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

export function attachConvexSync({
  client,
  documentId,
  ydoc,
  callbacks,
  fetchBytes = defaultFetchBytes,
}: {
  client: SyncClient;
  documentId: Id<"documents">;
  ydoc: Y.Doc;
  callbacks: SyncCallbacks;
  fetchBytes?: (url: string) => Promise<Uint8Array>;
}): SyncHandle {
  let destroyed = false;
  let closing = false; // destroy() in progress: flush, but schedule nothing new
  let synced = false;
  let degraded = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  const markDegraded = () => {
    if (degraded || destroyed) return;
    degraded = true;
    callbacks.onDegraded();
  };
  const markHealthy = () => {
    if (!degraded) return;
    degraded = false;
    if (synced) callbacks.onSynced();
  };

  // ---- pull ----
  let lastSeen = 0; // newest _creationTime applied
  const seen = new Map<string, number>(); // row id → _creationTime
  let pulling = false;
  let pullAgain = false;

  const pull = async (): Promise<void> => {
    if (destroyed) return;
    if (pulling) {
      pullAgain = true;
      return;
    }
    pulling = true;
    try {
      do {
        pullAgain = false;
        const rows = await client.query(api.ydoc.since, {
          documentId,
          after: Math.max(0, lastSeen - OVERLAP_MS),
        });
        if (destroyed) return;
        if (rows === null) {
          callbacks.onFailed({ stage: "pull", reason: "no-access" });
          return;
        }
        const fresh = rows.filter((r) => !seen.has(r.id));
        const parts: Uint8Array[] = [];
        for (const r of fresh) {
          if (r.update) parts.push(new Uint8Array(r.update));
          else if (r.url) parts.push(await fetchBytes(r.url));
        }
        if (destroyed) return;
        if (parts.length) Y.applyUpdate(ydoc, Y.mergeUpdates(parts), REMOTE);
        for (const r of fresh) {
          seen.set(r.id, r.createdAt);
          lastSeen = Math.max(lastSeen, r.createdAt);
        }
        // Forget ids that have fallen well behind the re-read window.
        for (const [id, t] of seen) if (t < lastSeen - 2 * OVERLAP_MS) seen.delete(id);
      } while (pullAgain && !destroyed);

      if (!synced) {
        synced = true;
        callbacks.onSynced();
        schedulePush(); // anything edited before the first pull landed
      }
      markHealthy();
    } catch (err) {
      console.error("[superdoc-sync] pull failed", err);
      markDegraded();
      later(() => void pull(), RETRY_MS);
    } finally {
      pulling = false;
    }
  };

  // ---- push ----
  let pending: Uint8Array[] = [];
  let pushing: Promise<void> | null = null;
  let pushTimer = false;

  const flush = async (): Promise<void> => {
    while (pushing) await pushing;
    if (pending.length === 0) return;
    const merged = Y.mergeUpdates(pending);
    pending = [];
    pushing = client
      .mutation(api.ydoc.push, { documentId, update: toArrayBuffer(merged) })
      .then(
        () => markHealthy(),
        (err: unknown) => {
          const code = errorCode(err);
          if (code === "UPDATE_TOO_LARGE" || code === "NO_ROOM") {
            callbacks.onFailed({ stage: "push", code });
            return;
          }
          console.error("[superdoc-sync] push failed, will retry", err);
          pending = [merged, ...pending]; // keep order: this batch goes first
          markDegraded();
          if (!destroyed && !closing) later(() => schedulePush(), RETRY_MS);
        },
      )
      .finally(() => {
        pushing = null;
      });
    await pushing;
  };

  const schedulePush = () => {
    if (pushTimer || destroyed || closing || !synced) return;
    pushTimer = true;
    later(() => {
      pushTimer = false;
      void flush();
    }, PUSH_DEBOUNCE_MS);
  };

  const onLocalUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return;
    pending.push(update);
    schedulePush();
  };
  ydoc.on("update", onLocalUpdate);

  // ---- subscriptions ----
  const unsubscribeHead = client.onUpdate(
    api.ydoc.head,
    { documentId },
    (head) => {
      if (head === null) {
        callbacks.onFailed({ stage: "subscribe", reason: "no-access" });
        return;
      }
      void pull();
    },
    (err) => {
      console.error("[superdoc-sync] head subscription error", err);
      markDegraded();
    },
  );
  const unsubscribeConnection = client.subscribeToConnectionState((state) => {
    if (state.hasEverConnected && !state.isWebSocketConnected) markDegraded();
    else if (state.isWebSocketConnected) void pull(); // catch up after a reconnect
  });

  return {
    async destroy() {
      if (destroyed || closing) return;
      closing = true;
      // Stop new work, but send what's already been typed before closing.
      ydoc.off("update", onLocalUpdate);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      pushTimer = false;
      await Promise.race([
        flush(),
        new Promise((resolve) => setTimeout(resolve, CLOSE_FLUSH_TIMEOUT_MS)),
      ]);
      destroyed = true;
      unsubscribeHead();
      unsubscribeConnection();
      await client.close();
    },
  };
}
