"use client";

import { useEffect, useState } from "react";

const POLL_MS = 5 * 60_000;
const DISMISS_KEY = "folio:update-dismissed";
const RELOAD_KEY = "folio:chunk-reload-attempted";

/** Inlined at build time by next.config's `env`. */
const BUILD_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";

const IS_PROD = process.env.NODE_ENV === "production";

// sessionStorage throws outright in some privacy modes, so every access is
// guarded — a tab that can't remember a dismissal should still work.
const session = {
  get(key: string): string | null {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      /* not worth surfacing */
    }
  },
  remove(key: string) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* not worth surfacing */
    }
  },
};

/**
 * Notices when this tab is running a build the server has replaced.
 *
 * Never reloads on its own: Folio holds longform drafts, so an unannounced
 * refresh mid-paragraph is the single worst thing this could do. All it does
 * is raise `updateReady`; the refresh is the reader's explicit choice.
 */
export function useAppVersion() {
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    if (!IS_PROD || updateReady) return;
    let cancelled = false;

    const check = async () => {
      if (document.visibilityState !== "visible") return;
      if (session.get(DISMISS_KEY)) return;
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const { version } = (await res.json()) as { version?: string };
        if (!cancelled && version && version !== BUILD_VERSION) {
          setUpdateReady(true);
        }
      } catch {
        // Offline, or the deployment is mid-swap. Stay quiet and try later —
        // there's nothing here worth a console line every five minutes.
      }
    };

    void check();
    const id = setInterval(check, POLL_MS);
    // This listener carries most of the feature's value: a tab backgrounded
    // for days catches the update the instant it's refocused, rather than
    // waiting out a poll interval that wasn't running while it was hidden.
    document.addEventListener("visibilitychange", check);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", check);
    };
  }, [updateReady]);

  return {
    updateReady,
    /** Quiet for the rest of this tab's session; a new tab asks again. */
    dismiss: () => {
      session.set(DISMISS_KEY, "1");
      setUpdateReady(false);
    },
  };
}

const CHUNK_ERROR =
  /ChunkLoadError|Loading chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed/i;

/**
 * A deploy deletes the hashed chunks a long-open tab is still about to lazily
 * import, so the import rejects before any toast could land. One reload fixes
 * it — the navigation fetches new HTML with the new chunk names.
 *
 * The sessionStorage guard is what keeps a genuinely broken build from
 * becoming an infinite reload loop; it re-arms only once this build has stayed
 * up long enough to look healthy, so the worst case is one reload per ten
 * good seconds rather than a spin.
 */
export function useChunkErrorRecovery() {
  useEffect(() => {
    if (!IS_PROD) return;

    const healthy = setTimeout(() => session.remove(RELOAD_KEY), 10_000);

    const recover = (message: string) => {
      if (!CHUNK_ERROR.test(message)) return;
      if (session.get(RELOAD_KEY)) return; // already tried once — don't loop
      session.set(RELOAD_KEY, "1");
      window.location.reload();
    };
    const onError = (e: ErrorEvent) =>
      recover(e.message || String(e.error ?? ""));
    const onRejection = (e: PromiseRejectionEvent) =>
      recover(e.reason instanceof Error ? e.reason.message : String(e.reason));

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      clearTimeout(healthy);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
}
