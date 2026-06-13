"use client";

import { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import { SignInButton, UserButton } from "@clerk/nextjs";
import { DocList } from "./DocList";

/** The desk: signed-out gets the pitch, signed-in gets their documents. */
export function HomeScreen() {
  return (
    <div className="flex min-h-dvh flex-col bg-[var(--folio-backdrop)]">
      <header className="flex items-center justify-between px-6 py-3">
        <span className="font-serif text-lg font-medium tracking-tight text-foreground">
          Folio
        </span>
        <Authenticated>
          <UserButton />
        </Authenticated>
      </header>

      <AuthLoading>
        <p className="flex-1 px-6 py-16 text-center text-foreground/50">
          Loading…
        </p>
      </AuthLoading>

      <Unauthenticated>
        <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
          <div className="space-y-3">
            <h1 className="font-serif text-5xl text-foreground">Folio</h1>
            <p className="max-w-md text-balance text-foreground/60">
              A writing space that knows what changed since you last looked — so
              Claude can react to your edits, not re-read your whole document.
            </p>
          </div>
          <SignInButton mode="modal">
            <button className="rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90">
              Sign in to start
            </button>
          </SignInButton>
        </main>
      </Unauthenticated>

      <Authenticated>
        <main className="flex flex-1 flex-col">
          <DocList />
        </main>
      </Authenticated>
    </div>
  );
}
