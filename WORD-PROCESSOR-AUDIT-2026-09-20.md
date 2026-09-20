# Word Processor Audit — Folio

**Date:** 2026-09-20
**Scope:** the document page — `/doc/[id]` and everything it mounts:
`DocWorkspace`, `DocEditor`, `Toolbar`, `FindReplace`, `Outline`, the seven
TipTap extensions in `components/extensions/`, `lib/export.ts`, `lib/fonts.ts`,
and the `.ProseMirror` half of `globals.css`.
**Out of scope:** the diff panel, Cleo, sharing/presence, the home screen, the
MCP door. Those are their own surfaces.
**Method:** full read of every file above plus the compiled CSS from a
production build; no runtime/browser verification except through the build.

---

## Verdict

This is a genuinely good editor, and unusually well commented — most of the
non-obvious decisions (the `.map().some(Boolean)` command pattern, TextStyle's
priority inversion, `preventUpdate` on merged transactions, the deliberate
absence of `clients.claim()`) carry a comment explaining *why*, which is what
made this audit fast. Per-control accessibility is better than most editors
twice its size.

The weaknesses cluster in two places:

1. **Failure paths are quieter than they should be.** The editor's happy path
   is careful; its unhappy path mostly reaches `console.error`. The autosave
   failure is the sharp end of this.
2. **Inputs from outside Folio aren't distrusted.** Find, replace, and paste
   all assume content shaped the way Folio writes it.

Six findings were filed as patches. Everything else is below, unfiled.

---

## Filed as patches

| Priority | Patch | Finding |
| --- | --- | --- |
| high | `d832df20` | Autosave failures are silent — no UI signal, no retry, no unload guard |
| medium | `f329df3b` | Find & replace misses matches spanning a formatting boundary (+ replace drops marks, + replacement is HTML-parsed) |
| medium | `90f3b780` | Pasted styled HTML stores `11pt`/`115%`/`0.5in` in Folio's own attrs; blanks the size dial |
| medium | `65ee0319` | Find bar is viewport-`fixed`, so it paints over the Cleo dock and the toolbar |
| medium | `37afc9f3` | SmartTypography does dashes and ellipses but leaves quotes/apostrophes straight |
| low | `3cb02e5e` | Editor surface and toolbar row have no accessible names |

The two highest-value ones are `d832df20` (a writer can lose work with no
warning) and `f329df3b` (Replace All silently leaves occurrences behind, which
is worse than finding nothing).

---

## Recommendations — UI/UX, unfiled

Ranked by value-to-effort. None of these are defects.

### 1. Retire the two `window.prompt` calls
`Toolbar.onLink` and `DocEditor.editWordGoal` both use `window.prompt`. On a
page this deliberately calm, a native OS modal is the single most jarring
thing in the experience — it's unstyleable, it's a full-screen sheet on
mobile, and it's awkward with a screen reader. The codebase already has the
right primitive: `useDropdownMenu` + the `SwatchPopover` shape. A small inline
popover for each would cost little and fix both at once.

There's a second reason: `prompt` blocks the event loop, which means it also
blocks the editor's debounce and any in-flight merge until it's dismissed.

### 2. Deliver the word-goal progress the schema already promises
`convex/schema.ts` says of `wordGoal`: *"shows progress instead of a raw
tally."* The UI shows `1,200 / 2,000 words` — a raw tally with a second
number. A thin progress underline on the pill, or a ring around it, would make
it glanceable, which is the whole point of a goal. Cheap, and it closes a gap
between the schema's stated intent and the surface.

### 3. Add "clear formatting"
There's currently no way to strip a block back to plain. `unsetAllMarks()`
plus resets for `fontSize`, `lineHeight`, `indent` and `textAlign` is a
handful of lines, and it's the standard escape hatch after a messy paste.
Pairs naturally with the paste-normalization patch (`90f3b780`).

### 4. More in the word-count pill
The badge is already the page's status surface, and it now knows the
selection. Character count and an estimated reading time are the two things
writers reach for next; a small popover on the pill would hold all of them
without adding chrome. Effort is low since the plumbing exists.

### 5. Discoverable shortcuts
Cmd/Cmd+S, Cmd+F, Tab/Shift-Tab indent, Cmd-click to open a link, and the
input rules (`--`, `...`) are all undiscoverable — nothing on the page
mentions any of them. A `?` popover listing them, reachable from the same
floating cluster as the outline button, would surface real functionality
that's currently invisible.

### 6. Outline could track the cursor
`Outline` is a good quick-jump list, but it doesn't indicate where you
currently are. Highlighting the heading containing the cursor turns it from a
jump list into an orientation aid, which matters more the longer the document
gets.

### 7. Superscript / subscript
The only inline marks missing that a prose writer actually asks for. The
footnote feature already renders `<sup>`, so the styling precedent exists.

---

## New features worth considering

Roughly ordered by how well they fit Folio's north star (a calm,
paper-forward, *curated* writing space — explicitly not a word processor with
every feature).

**Strong fit**

- **Focus / typewriter mode.** Dim everything but the current paragraph, or
  keep the caret vertically centred. This is the feature most aligned with
  what Folio is for, and it's mostly a decoration plugin plus a scroll
  handler.
- **Document-level type defaults.** The tier sizes (11/20/16/14/12px as of
  v0.39.0) are global constants. A per-document override — stored next to
  `fontFamily`, which already works exactly this way — would let a particular
  piece carry its own scale without touching the code.
- **Block-level drag handles.** Reordering a paragraph currently means
  cut-and-paste. The block-as-row data model makes this unusually natural
  here, since every top-level node already has a stable id.

**Good fit, more work**

- **Tables.** The one structural block genuinely missing. `@tiptap/extension-table`
  exists, but it needs the full end-to-end treatment: markdown/RTF/DOCX
  serializers in `lib/export.ts`, an `mdBlocks` case in `convex/mcpData.ts`,
  print styles, and a decision about how a table interacts with the
  block-as-row diffing. Budget for the export work, not the extension.
- **Comments / margin annotations.** The attribution gutter already
  establishes the visual language (a quiet marginal tick), and the block-row
  schema gives a natural anchor. This is the most *Folio-ish* big feature on
  the list — a writing space that knows what changed is one step from a
  writing space you can leave notes in.
- **Version history / snapshots.** The diff-since-last-visit machinery is
  half of this already. Periodic snapshots plus a restore would make the
  soft-delete safety net cover edits as well as deletions.

**Weak fit — do these only if asked for**

- Real-time collaborative cursors. Presence exists, but the merge model is
  last-writer-wins per block, not a CRDT; character-level co-editing would
  mean replacing `mergeRemoteChanges` with Y.js. Large, and the current model
  is honest about what it is.
- Image embedding. Nothing in the schema, export path, or print styles handles
  images, and every one of those would need work.

---

## Deliberately not recommended

- **Undo/redo buttons in the toolbar.** Standard in every word processor, and
  the keyboard shortcuts already work via StarterKit's `UndoRedo`. But Folio's
  whole positioning is "not a word processor," and the toolbar is already
  three-quarters full at `sm` (it collapses into `MoreMenu` below that).
  Adding two low-value buttons costs toolbar space and pushes the page toward
  the thing it's trying not to be.
- **A font-size stepper (+/− buttons).** Same reasoning: the numeric field is
  more precise and takes a third of the width.
- **Page-break / page-count UI.** Print already produces a clean paginated
  document via `@page`. Simulating pages on screen would be a large change to
  the editor's layout in exchange for a metaphor Folio doesn't otherwise use —
  the "paper" here is one continuous sheet, on purpose.

---

## Fixed during this sweep

For the record, these were the sweep's other four patches, all landed before
this audit was written:

- **v0.39.0** — heading tiers became real sizes (H1 20 / H2 16 / H3 14 /
  H4 12, body 11); heading ink declared in an unlayered rule so it can't lose
  the cascade; list lines can now become headings (ListItem's `content`
  widened), with the RTF/DOCX export gap that opened up closed in the same
  commit.
- **v0.39.1** — list bullets and numbers now match their line's text size, via
  a node decoration on the `<li>` rather than a stored attribute.
- **v0.40.0** — the word-count badge reads `930/1996 words` with a selection.
- **v0.41.0** — stale tabs get a dismissible "a newer Folio is ready" toast
  that flushes the pending save before reloading, and never reloads on its
  own.

One thing from v0.39.0 is still unconfirmed: the reported "headings don't
change colour in dark mode" could not be reproduced from the stylesheet — both
the production and Turbopack dev CSS already resolved heading colour correctly
in dark mode. The fix applied is defensive (an unlayered `color` declaration
that can't lose the cascade). If it recurs, the cause is runtime — most likely
an inline text-colour mark left on those headings — not CSS.
