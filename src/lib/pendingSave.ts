/**
 * A one-slot registry for "this tab has editor work that may not be on the
 * server yet."
 *
 * The update toast lives at the root layout; the editor that owns the pending
 * save lives several levels below it, and Folio only ever mounts one editor at
 * a time (DocBody keys it on documentId). A module-level slot beats threading
 * a context provider through the whole tree for a single function.
 *
 * Folio is a longform writing app, so reloading over an in-flight block save
 * is the worst thing the update toast could do — it flushes through here and
 * waits for the result before it touches window.location.
 */
type Flush = () => Promise<boolean>;

let pendingFlush: Flush | null = null;

/** Called by the editor on mount; returns its own cleanup. */
export function registerPendingSaveFlush(flush: Flush): () => void {
  pendingFlush = flush;
  return () => {
    // Only clear our own slot — a remount can register the next editor before
    // the previous one's cleanup runs.
    if (pendingFlush === flush) pendingFlush = null;
  };
}

/**
 * Push any pending edit to the server and report whether everything landed.
 * `true` also covers "there was no editor mounted" — nothing to lose. A
 * `false` is the caller's cue to warn instead of reloading.
 */
export async function flushPendingSaves(): Promise<boolean> {
  if (!pendingFlush) return true;
  try {
    return await pendingFlush();
  } catch (e) {
    console.error("Folio: flush before reload failed", e);
    return false;
  }
}
