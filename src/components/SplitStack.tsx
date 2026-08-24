"use client";

import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

const MIN_SPLIT = 0.2;
const MAX_SPLIT = 0.85;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const loadNumber = (key: string, fallback: number) => {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * A vertically stacked two-pane layout with a draggable divider between the
 * top and bottom sections. The split fraction persists to localStorage under
 * `storageKey` and double-clicking the divider resets it to `defaultSplit`.
 * Shared by the desktop dock and the mobile drawer so both resize the same
 * way and (optionally) the same persisted split.
 */
export function SplitStack({
  top,
  bottom,
  storageKey,
  defaultSplit,
  onDraggingChange,
}: {
  top: ReactNode;
  bottom: ReactNode;
  storageKey: string;
  defaultSplit: number;
  onDraggingChange?: (dragging: boolean) => void;
}) {
  const [split, setSplit] = useState(() =>
    clamp(loadNumber(storageKey, defaultSplit), MIN_SPLIT, MAX_SPLIT),
  );
  const columnRef = useRef<HTMLDivElement>(null);

  const startSplitDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const column = columnRef.current;
      if (!column) return;
      onDraggingChange?.(true);

      const compute = (clientY: number) => {
        const rect = column.getBoundingClientRect();
        return clamp((clientY - rect.top) / rect.height, MIN_SPLIT, MAX_SPLIT);
      };
      const onMove = (ev: PointerEvent) => setSplit(compute(ev.clientY));
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        onDraggingChange?.(false);
        window.localStorage.setItem(storageKey, compute(ev.clientY).toFixed(4));
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [storageKey, onDraggingChange],
  );

  const resetSplit = useCallback(() => {
    setSplit(defaultSplit);
    window.localStorage.setItem(storageKey, String(defaultSplit));
  }, [storageKey, defaultSplit]);

  return (
    <div ref={columnRef} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 overflow-hidden" style={{ height: `${split * 100}%` }}>
        {top}
      </div>

      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize sections"
        onPointerDown={startSplitDrag}
        onDoubleClick={resetSplit}
        className="group relative h-2 shrink-0 cursor-row-resize touch-none"
      >
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-black/10 transition group-hover:bg-foreground/30 dark:bg-white/10" />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">{bottom}</div>
    </div>
  );
}
