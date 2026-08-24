"use client";

import { useCallback, useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Id } from "@convex/_generated/dataModel";
import { DiffPanel } from "@/components/DiffPanel";
import { ClaudeReaction } from "@/components/ClaudeReaction";
import { SplitStack } from "@/components/SplitStack";
import { SPLIT_KEY, DEFAULT_SPLIT } from "@/lib/dockLayout";

// Persisted layout, with calm defaults matching the old fixed sidebar.
const WIDTH_KEY = "folio:dock:width";
const DEFAULT_WIDTH = 320; // = the previous w-80
const MIN_WIDTH = 260;

// The panel hugs the right edge, so its usable max grows with the viewport but
// never eats more than 60% of it.
const maxWidth = () =>
  typeof window === "undefined" ? 680 : Math.min(680, window.innerWidth * 0.6);

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));

const loadNumber = (key: string, fallback: number) => {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * The wide-screen "Changes + Cleo" dock. Drag the left edge to resize the whole
 * panel; drag the divider between the two sections to rebalance their heights.
 * Both sizes persist to localStorage; double-click a handle to reset it.
 * (Below lg the panel is a drawer instead — see DocWorkspace — and isn't sized
 * here.)
 */
export function ResizableDock({ documentId }: { documentId: Id<"documents"> }) {
  // Read persisted sizes lazily on first render. The dock only renders
  // client-side (it's inside <Authenticated>, which renders nothing on the
  // server), so there's no SSR markup to mismatch against.
  const [width, setWidth] = useState(() =>
    clamp(loadNumber(WIDTH_KEY, DEFAULT_WIDTH), MIN_WIDTH, maxWidth()),
  );
  const [dragging, setDragging] = useState(false);

  // A width persisted from a wider window shouldn't overflow the panel's own
  // 60%-of-viewport cap if the browser is later made narrower.
  useEffect(() => {
    const onResize = () => {
      setWidth((w) => clamp(w, MIN_WIDTH, maxWidth()));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const startWidthDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startWidth = width;
      const hi = maxWidth();
      setDragging(true);

      const onMove = (ev: PointerEvent) => {
        // Panel is on the right: dragging the handle left widens it.
        setWidth(clamp(startWidth + (startX - ev.clientX), MIN_WIDTH, hi));
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setDragging(false);
        const next = clamp(startWidth + (startX - ev.clientX), MIN_WIDTH, hi);
        window.localStorage.setItem(WIDTH_KEY, String(Math.round(next)));
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [width],
  );

  const resetWidth = useCallback(() => {
    setWidth(DEFAULT_WIDTH);
    window.localStorage.setItem(WIDTH_KEY, String(DEFAULT_WIDTH));
  }, []);

  return (
    <div
      className={`relative hidden shrink-0 lg:flex ${dragging ? "select-none" : ""}`}
      style={{ width }}
    >
      {/* Width handle — sits on the left edge, doubles as the panel border. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel width"
        onPointerDown={startWidthDrag}
        onDoubleClick={resetWidth}
        className="group absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none"
      >
        <div className="mx-auto h-full w-px bg-black/10 transition group-hover:bg-foreground/30 dark:bg-white/10" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col border-l border-black/10 dark:border-white/10">
        <SplitStack
          top={<DiffPanel documentId={documentId} />}
          bottom={<ClaudeReaction documentId={documentId} />}
          storageKey={SPLIT_KEY}
          defaultSplit={DEFAULT_SPLIT}
          onDraggingChange={setDragging}
        />
      </div>
    </div>
  );
}
