"use client";

import { useEffect, useState } from "react";

const DISMISSED_KEY = "folio-install-dismissed";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Registers the service worker and, when the browser offers to, surfaces a
 * small install banner matching Folio's card styling. Renders nothing until
 * the browser actually fires `beforeinstallprompt`. */
export function PWA() {
  const [installEvent, setInstallEvent] =
    useState<BeforeInstallPromptEvent | null>(null);
  // Lazy initializer, not an effect: `installEvent` is null on every first
  // paint (client and server alike) regardless of this value, so there's no
  // hydration mismatch to avoid — only whether the banner appears once the
  // browser actually offers to install, later.
  const [dismissed, setDismissed] = useState(
    () => typeof window !== "undefined" && localStorage.getItem(DISMISSED_KEY) === "1",
  );

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  useEffect(() => {
    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () =>
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  }, []);

  if (!installEvent || dismissed) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
  };

  const install = async () => {
    await installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    if (outcome === "accepted") setInstallEvent(null);
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 rounded-lg border border-foreground/10 bg-[var(--folio-paper)] p-4 shadow-md">
      <p className="text-sm font-medium text-foreground">Install Folio</p>
      <p className="mt-0.5 text-xs text-foreground/60">
        Add it to your dock for quicker access and an offline fallback.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          onClick={install}
          className="rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90"
        >
          Install
        </button>
        <button
          onClick={dismiss}
          className="rounded-full px-3 py-1.5 text-xs font-medium text-foreground/60 transition hover:bg-black/5 dark:hover:bg-white/10"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
