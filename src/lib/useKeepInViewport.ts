"use client";

import { useLayoutEffect, useRef } from "react";

const MARGIN = 8; // px of breathing room kept between a panel and the viewport edge

/**
 * Keeps an open dropdown/popover panel fully inside the viewport. Panels are
 * anchored to one edge of their trigger (`absolute left-0` / `right-0`), so
 * a trigger near the far edge of a narrow screen pushes them off-screen.
 * While `open`, this measures the panel and shifts it back with `transform`
 * (Tailwind v4's translate utilities use the separate `translate` property,
 * so the two compose; margins wouldn't move a right-anchored panel) and caps
 * its height to the space that's left. Re-runs on window resize and when the
 * panel's own size changes. Attach the returned ref to the panel element.
 */
export function useKeepInViewport<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;

    const fit = () => {
      el.style.transform = "";
      el.style.maxHeight = "";
      el.style.overflowY = "";
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const r = el.getBoundingClientRect();

      // Horizontal: shift whichever way it overflows; a panel wider than the
      // viewport pins to the left margin (its own width class should cap it).
      let dx = 0;
      if (r.right > vw - MARGIN) dx = vw - MARGIN - r.right;
      if (r.left + dx < MARGIN) dx = MARGIN - r.left;
      if (dx) el.style.transform = `translateX(${dx}px)`;

      // Vertical: never move it off its trigger — cap the height so it ends
      // at the viewport edge and scrolls instead. A downward panel shrinks
      // toward its top anchor, an upward (`bottom-*`) one toward its bottom.
      let room = Infinity;
      if (r.bottom > vh - MARGIN) room = vh - MARGIN - r.top;
      else if (r.top < MARGIN) room = r.bottom - MARGIN;
      if (room !== Infinity) {
        el.style.maxHeight = `${Math.max(120, room)}px`;
        el.style.overflowY = "auto";
      }
    };

    fit();
    window.addEventListener("resize", fit);
    // Content swaps (a menu switching to a sub-panel) change its size too.
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => {
      window.removeEventListener("resize", fit);
      observer.disconnect();
    };
  }, [open]);

  return ref;
}
