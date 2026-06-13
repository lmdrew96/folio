import { auth } from "@clerk/nextjs/server";
import { SignInButton, UserButton } from "@clerk/nextjs";
import { OpenDocButton } from "@/components/OpenDocButton";

export default async function Home() {
  const { userId } = await auth();
  const signedIn = userId !== null;

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-end px-6 py-3">
        {signedIn && <UserButton />}
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        <div className="space-y-3">
          <h1 className="text-4xl font-semibold tracking-tight">Folio</h1>
          <p className="max-w-md text-balance text-black/60 dark:text-white/60">
            A writing space that knows what changed since you last looked — so
            Claude can react to your edits, not re-read your whole document.
          </p>
        </div>

        {signedIn ? (
          <OpenDocButton />
        ) : (
          <SignInButton mode="modal">
            <button className="rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90">
              Sign in to start
            </button>
          </SignInButton>
        )}
      </main>
    </div>
  );
}
