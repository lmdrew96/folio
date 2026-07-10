# Folio

A writing space that knows what changed since you last looked — so Claude
can react to your edits, not re-read your whole document.

Folio persists every top-level editor block as its own row (block-as-row),
which makes per-block author attribution and diff-since-last-visit native to
the data model instead of a parsing problem. On top of that: a multi-document
desk, rich-text editing (TipTap), export to PDF/Word/Markdown/RTF/HTML/plain
text, System/Light/Dark theming, printing, and an installable PWA.

Two Claude surfaces live here:
- **Cleo** — the in-app sibling who reacts to what changed in a document, with
  her own memory of prior reactions to that document.
- **A read-only MCP door** — lets other Claude instances (Coru on claude.ai,
  Cody in the CLI, …) list, read, and diff-since-their-own-last-visit any
  document.

Stack: Next.js 16 (App Router) · Convex · Clerk · TipTap v3 · Tailwind v4.

## Setup

See [SETUP.md](./SETUP.md) for one-time setup (Convex, Clerk, Anthropic) and
how to run the app locally.
