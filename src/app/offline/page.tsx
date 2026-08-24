"use client";

import { useEffect } from "react";

export default function OfflinePage() {
  useEffect(() => {
    const onOnline = () => window.location.reload();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-[var(--folio-backdrop)] px-6 text-center">
      <div className="folio-card max-w-sm space-y-3">
        <h1 className="font-serif text-2xl text-foreground">You&rsquo;re offline</h1>
        <p className="text-sm text-foreground/60">
          Folio needs a connection to load and sync your documents. This page
          will reload automatically once you&rsquo;re back online.
        </p>
      </div>
    </div>
  );
}
