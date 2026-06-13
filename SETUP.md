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

## Patch 1 acceptance check

- App boots, `/` is reachable signed-out.
- `/doc/[id]` redirects to Clerk sign-in when signed out (middleware gate).
- The TipTap editor renders with the UniqueID extension on (every block gets a
  stable `id`).
- Type some blocks, click away (blur) to save, refresh → the same content reloads
  from Convex.
