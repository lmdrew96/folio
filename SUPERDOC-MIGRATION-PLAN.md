# SuperDoc Migration Plan — Folio

**Date:** 2026-09-30
**Decision:** replace Folio's custom TipTap editor with SuperDoc (`superdoc` 2.18.0 +
`@superdoc-dev/react` 1.16.2) so word-processing behavior, UI and UX come pre-built.
**Evidence:** the spike on branch `spike/superdoc` (worktree `../folio-superdoc-spike`,
throwaway — never merge it; port code out of it deliberately).

---

## What the spike proved

| Question | Result |
|---|---|
| Can SuperDoc's document live in Convex? | Yes. A custom provider adapter in SuperDoc's collaboration worker (`src/spike/collab-worker.ts`) stores Yjs updates in a `ydocUpdates` table behind `resolveAccess`. Survived reloads and a backend crash. |
| Next.js 16 / App Router / SSR? | Yes. Client-only via `dynamic(..., { ssr: false })`; production build passes. |
| Can block rows stay a derived copy? | Yes. `doc.blocks.list()` → TipTap-shaped rows → the existing `api.blocks.reconcile`. IDs are Word paraIds and **stable across reloads and edits**; diff `previousContent` and attribution work unchanged. |
| Can existing TipTap docs be imported? | Yes. Stored blocks → headless TipTap → HTML → `doc.replace({ type: "html" })`. Marks, highlight, 3-level nested lists, ordered lists and tables survived. Blockquote styling did not. |
| Inline attribution gutter? | Yes. Every block type, including tables and paragraphs after tables, gets a correctly placed tick. |
| Typing feel | Good. Shortcuts and toolbar work — **except Cmd+Delete** (delete to line start), which deletes one character. Option+Delete works. |

## Constraints carried into the build

- **Licence.** `superdoc` is AGPL; its required core `@superdoc/docx-engine` is proprietary.
  Free use is allowed only within AGPL terms, and the licence bans AI analysis of engine
  internals — engine bugs are a black box to us. Folio must offer its source to users
  (collaborators count) — linked in-app to https://github.com/lmdrew96/folio. Telemetry is on by default: always pass `telemetry: { enabled: false }`.
- **SuperDoc owns the Y.Doc.** v2 rejects an app-supplied `{ ydoc, provider }`; persistence
  must be a provider adapter inside its collaboration worker (`workerUrls.collaboration`).
- **Rooms are DOCX-only and need a base file** (`url: BlankDOCX`). `roomMode: "create"`
  fails on an existing room; `"join"` for everything after the first open.
- **When sync is down, formatting commands silently stop** while typing continues.
- **Weight:** ~22 MB of editor JS plus a 6 MB worker, loaded only on the document page.
- **No approximations of native shortcuts** — a missing shortcut beats one that behaves
  differently (Cmd+Delete stays a gap until SuperDoc fixes it upstream).

---

## Phases

Each phase ends usable and shippable on its own. Nothing touches existing documents
until Phase 4.

### Phase 1 — Storage foundation (backend + worker, no UI change)

1. Schema: add `ydocUpdates` (as in the spike) and `documents.editor: v.optional(v.literal("superdoc"))`.
   The flag is the switch: a doc with it set opens in SuperDoc and **must never** be opened
   by the TipTap editor again (TipTap would write blocks the Y.Doc doesn't know about).
2. Room claim, not guess: replace the spike's `hasRoom` query with a `claimRoom` mutation that
   atomically decides create-vs-join, so two tabs opening a brand-new doc can't race.
3. Productionize the adapter (`src/superdoc/collab-worker.ts`):
   - token refresh (Clerk tokens expire; the spike fetched one per connection),
   - flush pending updates before `close()` (the spike can drop the last edit on teardown),
   - connection state reported out of the worker (feeds Phase 2's offline indicator).
4. **Compaction.** A scheduled Convex function merges a document's update rows into one
   snapshot row when they pass ~100. Snapshots over ~900 KB go to Convex file storage
   (1 MB value limit). Clients already dedupe by row id, and re-applying merged state is a
   no-op in Yjs, so compaction is invisible to open tabs.
5. Build step: `scripts/build-superdoc-assets.mjs` (esbuild) wired into `pnpm build`, output
   to `public/superdoc/`. Pin `superdoc` to an exact version; the worker and page must match.

**Done when:** unit-level checks pass — push/pull under auth, claimRoom race, compaction
round-trip (content identical before/after).

**Status (2026-09-30): committed on branch `superdoc-migration` as v0.52.0; deployed to dev.**
- `convex/ydoc.ts`: `claimRoom` (create / join / wait, 60 s stale-claim takeover), `head`
  (`{ latest, count }` — count so an out-of-order row still wakes subscribers), `since`,
  `push`, and compaction (`compact` → `commitCompaction`, lossless `Y.mergeUpdates`,
  file storage above 800 KB). Purge cascade covers the new tables and blobs.
- `src/superdoc/convexProvider.ts` (sync logic, testable) + `collab-worker.ts` (entry);
  `pnpm dev` / `pnpm build` build the worker into gitignored `public/superdoc/`.
- Tests: `pnpm test` — 10 backend (convex-test, pinned 0.0.54 for Convex 1.41) + 7 adapter.
- Verified on the dev deployment: both compaction paths (inline and file storage) run in
  Convex's real runtime with text intact. Prod not deployed.

### Phase 2 — The editor surface (new docs only, behind a dev flag)

1. `src/components/SuperDocEditor.tsx` mounted by `DocWorkspace` when `documents.editor === "superdoc"`.
2. **Offline/reconnect state:** a visible indicator when the adapter reports disconnected,
   and automatic reconnect. Replaces `lib/pendingSave.ts` and the TipTap-era beforeunload guard.
3. **Look and feel** — this needs a concrete visual spec from you before any CSS:
   the paginated/web layout toggle, SuperDoc's full toolbar styling, dark mode,
   and registering Folio's prose fonts (Fraunces etc.) via `fonts`. Fix the Folio
   `globals.css` bleed the spike showed (white text, highlight contrast).
4. Extraction on save, debounced (the spike's `extract.ts`), upgraded to carry **bold /
   italic / links** into block rows so Cleo and the MCP tools keep reading formatting.
   Investigate `doc.getMarkdown` / per-block queries for inline runs first.

**Done when:** a new doc can be written, formatted, shared and reopened; Cleo, the diff
panel and the MCP tools read it correctly.

**Status (2026-10-02): Phase 2 complete on `superdoc-migration` (v0.53.0 + v0.54.0),
checked by hand on dev.**
- Look & feel (v0.54.0): toolbar fits its column (`responsiveTo: "container"`, overflow menu);
  Pages/Continuous dropdown (per device, remounts the editor); unused controls removed;
  Folio theme via `--sd-*` variables; dark mode inverts the paper (inline black → Folio ink);
  13 fonts self-hosted from @fontsource-variable (latin + latin-ext, so Romanian renders),
  new documents default to Fraunces; pages centred; overflow-menu icon/caret/stroke fixes.
- claimRoom now takes a per-editor `claimToken` so a remount (StrictMode) can't strand a new
  document on "Opening…".
- `SuperDocEditor.tsx`, routed by `DocBody` on `documents.editor`; dev-only "New SuperDoc
  document (dev)" button (compiled out of production builds).
- `blocks.reconcile` takes `source: "superdoc"` and rejects a write from the wrong editor
  (`EDITOR_MISMATCH`) — a stale TipTap tab can't clobber a SuperDoc document, or vice versa.
- Extraction (`src/superdoc/extract.ts`): `blocks.list` + `projectMarkdown` → rows with
  bold/italic/strike/underline/code/links and real tables.
- Offline: the save pill reads "Not saved — reconnecting…"; unload is guarded while unsynced;
  the update toast won't reload over an unsynced document.
- Known gap for Phase 3: **printing a SuperDoc document prints a blank page** — the print
  allowlist only shows `.folio-paper`.

### Phase 3 — Folio's own features on the new surface

| Feature | Approach |
|---|---|
| Attribution gutter | SuperDoc extension **block decorations** (`data-author` + class), not the spike's DOM overlay; hover tooltip from `data-author`. |
| Word count / goal | From extracted block text; reuse the existing goal UI. |
| Outline | `blocks.list` headings + `superdoc.navigateTo({ kind: "block", nodeId })`. |
| Find & replace | SuperDoc's built-in; drop `FindReplace.tsx`. |
| Export | DOCX and PDF from SuperDoc natively; md / html / txt from its converters or from block rows. RTF dropped. |
| Print | Replace the `@media print` allowlist with SuperDoc's paginated output / PDF. |
| Smart typography | Check SuperDoc's built-in behavior first; otherwise a SuperDoc extension. Includes the arrow patch (`-->`, `<--`). |
| Footnotes | Native DOCX footnotes; import converts Folio's footnote nodes. |
| Per-doc font + word goal | Keep on `documents`; font applied as the document default. |
| Presence | Keep `PresenceBadge`; SuperDoc awareness (live cursors) is optional, later. |

**Done when:** a SuperDoc doc has everything a TipTap doc has today, except the listed
Cmd+Delete gap.

**Status (2026-10-02): shipped on `superdoc-migration` as v0.55.0; checked in Chrome on dev,
printing checked by Nae.**
- Attribution: `src/superdoc/folioExtension.ts` block decorations
  (`data-superdoc-ext-folio-*`). SuperDoc doesn't decorate the continuous layout, so
  SuperDocEditor stamps the same attributes there itself. Tooltip computed on hover.
- Word count / selection count / goal + outline: `SuperDocFooter.tsx`, from the extraction
  pass; outline jumps with `navigateTo`. Extraction now also runs on the extension's mutation
  hook — `onEditorUpdate` misses style-only changes (a paragraph made a heading).
- Export: `src/superdoc/exportDocument.ts` — DOCX native, Markdown/HTML from converters,
  plain text from the block list (SuperDoc's `getText` runs paragraphs together), PDF via print.
- Smart typography: `src/superdoc/typography.ts` (+ arrows: → ← ↔ ⇒). Applied after a 150 ms
  typing pause by replaying the current run of typed characters — keystrokes land in the
  worker after the keydown, so per-keystroke checks can't work. Undo sticks.
- Print: `.folio-superdoc` joins the print allowlist; paginated pages print 1:1 on a
  margin-free named page (`@page superdoc-page`). **Unverified** — needs a print preview,
  and long documents may hit SuperDoc page virtualisation.
- Find & replace: SuperDoc's built-in search. Footnotes: native DOCX footnotes, conversion is
  Phase 4.
- Styles: new docs start from a Folio DOCX template (`scripts/folio-docx-template.mjs`,
  built to `public/superdoc/folio-template.docx`) — Fraunces throughout, 1.4 line spacing,
  Title/Heading 1–6/Subtitle/Quote in automatic ink so dark mode can invert them. Replaces
  the blue Aptos Display headings of SuperDoc's blank DOCX.
- Fonts: one full Latin + Latin Extended woff2 per style, committed in
  `assets/superdoc-fonts/` (`scripts/fetch-superdoc-fonts.py`, from google/fonts, OFL).
  SuperDoc registers one source per face, so @fontsource's split unicode-range subsets
  were rejected ("source cannot be replaced") and Romanian fell back. fontsource removed.

### Phase 4 — Converting existing documents

1. **Convert on first open**, per document, using the spike's import path.
2. **Keep the original.** Before converting, copy the doc's current TipTap block content
   to a `legacyContent` snapshot (row or file storage). Rollback = clear `documents.editor`
   and restore it.
3. **Verify before switching.** After import, compare extracted text against the original
   blocks' text; on mismatch, don't set the flag — log it and leave the doc on TipTap.
4. Rehearse on a copy first: convert your real documents on the dev deployment (or a local
   copy) and read them side by side before anything touches prod. Prod Convex commands
   stay yours to run.
5. Don't run conversions while a TipTap tab has the same doc open (the standing Tangle
   gotcha: the open editor's flush overwrites migrated content).

**Done when:** every document is flagged `superdoc`, verified, with its legacy snapshot kept.

**Status (2026-10-02): built on `superdoc-migration` (v0.56.0). Rehearsed on the dev
deployment: all 15 TipTap documents there converted and passed the check (nested lists,
links, colours, emoji, Romanian); two fixtures covered footnotes, blockquotes, tables and
highlights. Prod not touched.**
- Trigger: `DocWorkspace` opens an unconverted document in `SuperDocEditor` with `legacy` set
  (dev builds only — `CONVERT_ON_OPEN`). The editor converts it, then stays open as its editor.
- Import (`src/superdoc/runConversion.ts`): rows → HTML (`legacyHtml.ts`) → `replace` into a
  room started from the template in the document's own font (one template per font, built to
  `public/superdoc/templates/`). Blockquotes get the Quote style. Footnote references travel as
  `⟦fnN⟧` placeholders and are swapped for real DOCX footnotes; highlighted text travels between
  `⟦hN⟧…⟦/h⟧` markers and gets its exact tint via `format.apply` (SuperDoc's HTML import turns
  every highlight into Word yellow, and drops span backgrounds).
- Check (`convertLegacy.ts` `alignBlocks`): each TipTap block's text, whitespace ignored, must
  reappear in order across the SuperDoc blocks; footnote count must match. Failure →
  `conversion.fail`: room dropped, reason stored in `documents.conversionFailure`, the document
  stays on TipTap and isn't retried.
- Switch (`convex/conversion.ts` `finish`, one transaction): refuses if a TipTap tab saved
  since the content was read; copies the TipTap rows to `legacyBlocks`; writes the new rows
  inheriting each source block's author and timestamps (attribution and "since you last
  looked" carry over); keeps deletion tombstones; sets `editor: "superdoc"`.
- By hand: `npx convex run conversion:status`, `conversion:revert '{"documentId": …}'`,
  `conversion:clearFailure '{"documentId": …}'`.
- Known losses: footnote text arrives unformatted; a footnote or highlight inside a table
  cell fails the conversion (blocks.list doesn't reach cell text), leaving the doc on TipTap.
- Dev rehearsal leftover: "PSYC 100 PollEv Questions" converted before the highlight fix, so its
  highlights are Word yellow — `revert` it and reopen to convert again.

### Phase 5 — Cutover and cleanup

1. New documents default to SuperDoc.
2. After a soak period with no rollbacks, delete: `DocEditor.tsx`, `Toolbar.tsx`,
   `FindReplace.tsx`, `components/extensions/*`, `mergeRemoteChanges`, the TipTap
   dependencies, and the `.ProseMirror` half of `globals.css`.
3. Drop `legacyContent` snapshots after a second soak.
4. Close the superseded patches (below) and update the changelog.

**Status (2026-10-02): cutover code built on `superdoc-migration`.** `documents.create`
always makes a SuperDoc document; conversion on open runs in every build (a document whose
conversion failed still opens in TipTap); the AGPL source link is in "What's new". Steps 2–3
wait for the soak.

**Ship order** (prod steps are Nae's):
1. `pnpm changelog`, commit, merge `superdoc-migration` → `main` (not pushed yet).
2. `npx convex deploy` — prod schema + `conversion.*` must exist before any new frontend
   loads, or opening a document fails.
3. Push `main` → Vercel deploys the frontend.
4. Open each document once (it converts); `npx convex run --prod conversion:status` to
   confirm none failed. Check the editor on the phone / installed PWA.
5. Rollback for one document: `npx convex run --prod conversion:revert '{"documentId": …}'`.
   There is no whole-app rollback by redeploying the old frontend: it can't open converted
   documents, so revert documents first.

---

## ChaosPatch impact

**Superseded by the migration** (close with a note when Phase 5 lands):
- `b415e136` inconsistent line spacing
- `3c228d2f` save pill centred on viewport (the pill goes away)

**Carried into the new editor:**
- `cbc30fa5` arrows render → Phase 3 smart typography
- `d912cbab` overflowing components → re-check against SuperDoc's own menus

**Unaffected** (block rows stay the read model): the MCP patches (`55be16ea`, `105de407`,
`29e68b57`, `90d3281e`) and drag-and-drop filing (`f5ec208a`).

**Sequencing with `9fddfde1` (Cloudflare Workers migration):** do one at a time. The
worker bundle is a static asset under the 25 MiB per-file limit, but it's cleaner to
migrate hosts first or after, not during.

---

## Decisions (2026-09-30)

1. **Look:** a per-user toggle between paginated and web layout. `viewOptions.layout` is
   initial-only, so toggling remounts the editor (content reloads from Convex — nothing
   lost). Default: paginated.
2. **Toolbar:** SuperDoc's full toolbar.
3. **RTF export:** dropped.
4. **Source offer (AGPL):** link to https://github.com/lmdrew96/folio in the app.
5. **Cmd+Delete:** accepted as a gap; no upstream issue.

## Risks

- **Engine is a black box.** If SuperDoc has an editing bug, we can report it but not
  debug it. Mitigation: pin versions; upgrade deliberately.
- **Vendor/licence drift.** The engine licence can change unilaterally. Mitigation:
  pinned versions, and block rows remain a complete readable copy of every document.
- **Mobile/PWA:** untested. Check SuperDoc on your phone early in Phase 2; the service
  worker will also be caching ~28 MB of editor assets.
- **Unknown until built:** dark mode support, smart quotes, inline marks in extraction.
