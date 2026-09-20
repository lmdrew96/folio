"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { findReplacePluginKey, type FindMatch } from "./extensions/find-replace";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type SearchOptions = { matchCase: boolean; wholeWord: boolean };

/**
 * Compile the query, folding each quote character to a class that matches all
 * of its forms. SmartTypography curls quotes as they're typed, so a draft holds
 * “ ” ‘ ’ while the keyboard produces " and ' — without this, searching for a
 * quote a writer can see never matches it.
 */
function buildRegExp(query: string, { matchCase, wholeWord }: SearchOptions): RegExp | null {
  if (!query) return null;
  const folded = escapeRegExp(query)
    .replace(/["\u201c\u201d]/g, '["\u201c\u201d]')
    .replace(/['\u2018\u2019]/g, "['\u2018\u2019]");
  // Unicode-aware boundaries rather than \b, which is ASCII-only and would
  // treat every accented letter as a word edge.
  const source = wholeWord
    ? `(?<![\\p{L}\\p{N}_])${folded}(?![\\p{L}\\p{N}_])`
    : folded;
  try {
    return new RegExp(source, `gu${matchCase ? "" : "i"}`);
  } catch {
    return null; // a query the engine won't take simply finds nothing
  }
}

/** A run of text inside one textblock, with the document position of its first character. */
type Segment = { text: string; from: number };

/**
 * The searchable runs of the document.
 *
 * ProseMirror splits text nodes at every mark boundary, so `hello **world**`
 * is two nodes — searching them separately (what this used to do) could never
 * match a phrase that crossed a bold, italic, link, highlight or color span.
 * Joining a textblock's text nodes into one string fixes that.
 *
 * An inline atom ends the run rather than joining it: `footnoteRef` occupies a
 * single document position but renders as `[3]`, so any text after it in the
 * same string would map back to the wrong position. Runs also never cross a
 * block boundary, so a query can't match across a paragraph break.
 */
function textSegments(doc: PMNode): Segment[] {
  const segments: Segment[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true; // keep descending — lists, quotes, footnotes
    let text = "";
    let start = -1;
    node.forEach((child, offset) => {
      if (child.isText && child.text) {
        if (start === -1) start = pos + 1 + offset;
        text += child.text;
      } else if (text) {
        segments.push({ text, from: start });
        text = "";
        start = -1;
      }
    });
    if (text) segments.push({ text, from: start });
    return false; // a textblock holds only inline content
  });
  return segments;
}

function findMatches(editor: Editor, query: string, options: SearchOptions): FindMatch[] {
  const re = buildRegExp(query, options);
  if (!re) return [];
  const matches: FindMatch[] = [];
  for (const segment of textSegments(editor.state.doc)) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(segment.text))) {
      matches.push({
        from: segment.from + m.index,
        to: segment.from + m.index + m[0].length,
      });
      // A zero-length match (possible with a whole-word query on an empty
      // string) would spin here forever.
      if (m[0].length === 0) re.lastIndex += 1;
    }
  }
  return matches;
}

/**
 * Swap one range for literal text, keeping the formatting of what it replaced.
 *
 * `schema.text` rather than Tiptap's `insertContentAt`: that runs a replacement
 * string through DOMParser, so `&amp;` arrived as `&` and `<b>` became
 * formatting or vanished outright.
 *
 * Marks come from the node *at* `from`, not `resolve(from).marks()` — at a run
 * boundary the latter reports the marks of the node before the match, which is
 * the run the writer isn't replacing.
 */
function applyReplacement(
  tr: Transaction,
  doc: PMNode,
  schema: Schema,
  from: number,
  to: number,
  text: string,
): void {
  if (!text) {
    tr.delete(from, to);
    return;
  }
  const marks = doc.nodeAt(from)?.marks ?? doc.resolve(from).marks();
  tr.replaceWith(from, to, schema.text(text, marks));
}

const BTN =
  "flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-sm text-foreground/60 transition hover:bg-black/5 hover:text-foreground disabled:opacity-40 dark:hover:bg-white/10";
const BTN_ON = "bg-black/10 text-foreground dark:bg-white/15";

/** Invisible-until-invoked (Cmd/Ctrl+F) find bar over the editor. Doesn't
 *  claim any toolbar space — a floating overlay, gone entirely when closed. */
export function FindReplace({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [active, setActive] = useState(0);
  const [docVersion, setDocVersion] = useState(0);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onUpdate = () => setDocVersion((v) => v + 1);
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
    };
  }, [editor]);

  const matches = useMemo(
    () => (open ? findMatches(editor, query, { matchCase, wholeWord }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, open, query, docVersion, matchCase, wholeWord],
  );

  const close = () => {
    setOpen(false);
    setQuery("");
    setReplacement("");
    setActive(0);
    editor.commands.focus();
  };

  // Cmd/Ctrl+F opens the bar and swallows the browser's own find-in-page;
  // Escape closes it from anywhere, not just while the input is focused.
  useEffect(() => {
    // Searching the document is only what Cmd+F means while the document has
    // focus. In the Cleo chat box or the title field it means "find in this
    // field", so the shortcut is left to the browser there.
    const ownsFocus = (target: EventTarget | null): boolean => {
      const el = target instanceof HTMLElement ? target : null;
      if (!el) return true; // nothing focused — the page at large, so ours
      if (editor.view.dom.contains(el) || rootRef.current?.contains(el)) return true;
      return !(
        el.isContentEditable ||
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT"
      );
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        if (!ownsFocus(e.target)) return;
        e.preventDefault();
        setOpen(true);
      } else if (e.key === "Escape" && open) {
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // `active` can point past the end once matches shrink (a replace, or the
  // query narrowing) — clamp it during render, the same "adjust while
  // rendering" pattern DocTitleEditor/FontSizeControl use, rather than a
  // setState-in-effect round trip.
  const activeIndex = matches.length === 0 ? -1 : Math.min(active, matches.length - 1);
  if (activeIndex !== -1 && activeIndex !== active) setActive(activeIndex);

  // Keeps the plugin's decorations and the editor's own selection in sync
  // with the current match set — a real side effect, so it stays in an effect.
  useEffect(() => {
    if (!open) {
      editor.view.dispatch(editor.state.tr.setMeta(findReplacePluginKey, { matches: [], active: -1 }));
      return;
    }
    editor.view.dispatch(
      editor.state.tr.setMeta(findReplacePluginKey, { matches, active: activeIndex }),
    );
    if (activeIndex !== -1) {
      const m = matches[activeIndex];
      editor.chain().setTextSelection({ from: m.from, to: m.to }).scrollIntoView().run();
    }
  }, [editor, open, matches, activeIndex]);

  const goNext = () => {
    if (matches.length === 0) return;
    setActive((a) => (a + 1) % matches.length);
  };
  const goPrev = () => {
    if (matches.length === 0) return;
    setActive((a) => (a - 1 + matches.length) % matches.length);
  };

  const replaceOne = () => {
    const m = matches[activeIndex];
    if (!m) return;
    const { state } = editor;
    const tr = state.tr;
    applyReplacement(tr, state.doc, state.schema, m.from, m.to, replacement);
    editor.view.dispatch(tr);
    editor.commands.focus();
  };

  const replaceAll = () => {
    if (matches.length === 0) return;
    const { state } = editor;
    const tr = state.tr;
    // Last-to-first: replacing a later match never shifts an earlier match's
    // still-pending position, so every position (and every mark read off the
    // original doc) stays valid for the whole pass.
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      applyReplacement(tr, state.doc, state.schema, m.from, m.to, replacement);
    }
    editor.view.dispatch(tr);
    editor.commands.focus();
  };

  if (!open) return null;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Find and replace"
      // print:hidden explicitly: the print stylesheet hides desk chrome via
      // `.fixed`, which used to cover this bar. Now that it's `absolute` it
      // needs its own rule, the same way the editor toolbar carries one.
      className="absolute right-4 top-3 z-30 flex w-[calc(100%-2rem)] max-w-sm flex-col gap-1.5 rounded-lg border border-foreground/10 bg-[var(--folio-paper)] p-2 shadow-md print:hidden"
    >
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (e.shiftKey) goPrev();
              else goNext();
            }
          }}
          placeholder="Find…"
          aria-label="Find"
          className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-sm text-foreground outline-none placeholder:text-foreground/40"
        />
        <span className="shrink-0 px-1 text-xs tabular-nums text-foreground/40">
          {matches.length === 0 ? "0/0" : `${activeIndex + 1}/${matches.length}`}
        </span>
        <button
          type="button"
          onClick={goPrev}
          disabled={matches.length === 0}
          aria-label="Previous match"
          className={BTN}
        >
          ‹
        </button>
        <button
          type="button"
          onClick={goNext}
          disabled={matches.length === 0}
          aria-label="Next match"
          className={BTN}
        >
          ›
        </button>
        <button
          type="button"
          onClick={() => setMatchCase((c) => !c)}
          aria-pressed={matchCase}
          aria-label="Match case"
          title="Match case"
          className={`${BTN} px-2 text-xs ${matchCase ? BTN_ON : ""}`}
        >
          Aa
        </button>
        <button
          type="button"
          onClick={() => setWholeWord((w) => !w)}
          aria-pressed={wholeWord}
          aria-label="Whole word only"
          title="Whole word only"
          className={`${BTN} px-2 text-xs ${wholeWord ? BTN_ON : ""}`}
        >
          W
        </button>
        <button
          type="button"
          onClick={() => setShowReplace((s) => !s)}
          aria-expanded={showReplace}
          aria-label="Toggle replace"
          className={`${BTN} px-2 text-xs`}
        >
          Replace
        </button>
        <button type="button" onClick={close} aria-label="Close find and replace" className={BTN}>
          ×
        </button>
      </div>
      {showReplace && (
        <div className="flex items-center gap-1">
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder="Replace with…"
            aria-label="Replace with"
            className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-sm text-foreground outline-none placeholder:text-foreground/40"
          />
          <button
            type="button"
            onClick={replaceOne}
            disabled={matches.length === 0}
            className={`${BTN} px-2 text-xs`}
          >
            Replace
          </button>
          <button
            type="button"
            onClick={replaceAll}
            disabled={matches.length === 0}
            className={`${BTN} px-2 text-xs`}
          >
            All
          </button>
        </div>
      )}
    </div>
  );
}
