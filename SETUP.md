# Folio — local setup

Folio is a writing space built on **block-as-row** persistence: every top-level
block in the editor is its own Convex row with a stable id, so the app can do
per-block attribution and diff-since-last-visit natively. (See the patch specs
in ChaosPatch for the full v0 plan.)

Stack: Next.js 16 (App Router) · Convex · Clerk · TipTap v3 · Tailwind v4.

---

## One-time setup

You need a Convex deployment and a Clerk application. Both require browser login,
so these steps are yours to run.

### 1. Convex

```bash
npx convex dev
```

This logs you in, creates a dev deployment, writes `CONVEX_DEPLOYMENT` +
`NEXT_PUBLIC_CONVEX_URL` into `.env.local`, generates `convex/_generated/*`, and
then keeps running to push schema/function changes. Leave it running in its own
terminal.

### 2. Clerk

1. Create an application at https://dashboard.clerk.com.
2. Copy the two API keys into `.env.local`:
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
   - `CLERK_SECRET_KEY`
3. Create a **JWT template** named exactly `convex`
   (Clerk dashboard → JWT Templates → New → Convex). Copy its **Issuer** URL.

### 3. Tell Convex about Clerk

On the Convex dashboard → your dev deployment → Settings → Environment Variables,
add:

```
CLERK_JWT_ISSUER_DOMAIN = <the Issuer URL from the Clerk template>
```

`convex/auth.config.ts` reads this to validate Clerk tokens.

### 4. Anthropic (for the Claude reaction panel — Patch 5)

Add your Anthropic API key to `.env.local` (server-side only — the `/api/react`
route holds it; never expose it client-side):

```
ANTHROPIC_API_KEY = <your key from console.anthropic.com>
```

Without it, the editor still works fully; only the "React to what changed"
button returns an error.

### 5. Run the app

```bash
cp .env.local.example .env.local   # then fill in the values above
pnpm dev                           # in a second terminal (convex dev stays running)
```

Open http://localhost:3000 → sign in → "Open your document" → you're in the
editor at `/doc/<id>`.

---

## Current state (v0.18.1)

Folio is well past its original v0 scope. For the full patch-by-patch history,
`git log --oneline` reads as a changelog — every commit is versioned
(`v0.1.0` through the current release). The short version:

- **Editor** — multi-document desk (create/rename/delete/restore), rich-text
  toolbar, smart dashes/ellipsis, tab-to-indent, Ctrl/Cmd+S save, System/Light/Dark
  theming, print support, and export to PDF/Word/Markdown/RTF/HTML/plain text.
- **Block-as-row continuity** — per-block author attribution and
  diff-since-last-visit are native to the schema (see the header comment
  above), not a parsing layer bolted on top.
- **Cleo** — the in-app Claude sibling that reacts to what changed in a
  document, with her own memory of prior reactions to that document (`src/lib/identity.ts`,
  `src/app/api/react/route.ts`).
- **Read-only MCP door** — external Claude siblings (Coru, Cody, …) can list,
  read, and diff-since-their-own-last-visit any of Nae's documents
  (`convex/http.ts`).
- **PWA** — installable, with an offline fallback page and a service worker
  scoped to app-shell caching only (never Convex/Clerk traffic).

The acceptance check below is what "Patch 1" (the very first commit) verified,
kept for historical reference — every step it describes still holds, it's
just no longer the whole app.

### Patch 1 acceptance check (historical — v0.1.0)

- App boots, `/` is reachable signed-out.
- `/doc/[id]` redirects to Clerk sign-in when signed out (middleware gate).
- The TipTap editor renders with the UniqueID extension on (every block gets a
  stable `id`).
- Type some blocks, click away (blur) to save, refresh → the same content reloads
  from Convex.
