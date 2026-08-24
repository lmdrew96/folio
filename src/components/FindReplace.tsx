"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { findReplacePluginKey, type FindMatch } from "./extensions/find-replace";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMatches(editor: Editor, query: string): FindMatch[] {
  if (!query) return [];
  const re = new RegExp(escapeRegExp(query), "gi");
  const matches: FindMatch[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(node.text))) {
      matches.push({ from: pos + m.index, to: pos + m.index + m[0].length });
    }
  });
  return matches;
}

const BTN =
  "flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-sm text-foreground/60 transition hover:bg-black/5 hover:text-foreground disabled:opacity-40 dark:hover:bg-white/10";

/** Invisible-until-invoked (Cmd/Ctrl+F) find bar over the editor. Doesn't
 *  claim any toolbar space — a floating overlay, gone entirely when closed. */
export function FindReplace({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [active, setActive] = useState(0);
  const [docVersion, setDocVersion] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onUpdate = () => setDocVersion((v) => v + 1);
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
    };
  }, [editor]);

  const matches = useMemo(
    () => (open ? findMatches(editor, query) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, open, query, docVersion],
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
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
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
    editor.chain().focus().insertContentAt({ from: m.from, to: m.to }, replacement).run();
  };

  const replaceAll = () => {
    if (matches.length === 0) return;
    let chain = editor.chain().focus();
    // Last-to-first: replacing a later match never shifts an earlier match's
    // still-pending position.
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      chain = chain.insertContentAt({ from: m.from, to: m.to }, replacement);
    }
    chain.run();
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Find and replace"
      className="fixed right-4 top-14 z-30 flex w-full max-w-sm flex-col gap-1.5 rounded-lg border border-foreground/10 bg-[var(--folio-paper)] p-2 shadow-md"
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
