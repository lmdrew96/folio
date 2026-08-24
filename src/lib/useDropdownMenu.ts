"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/**
 * Shared open/close + keyboard behavior for the app's small trigger-button
 * dropdowns (Toolbar's swatch/font/line-spacing/export menus, ThemeToggle) —
 * outside-click close, Escape close (returns focus to the trigger), and
 * Up/Down/Home/End roving focus among the panel's buttons. The WAI-ARIA
 * menu-button pattern; each caller keeps its own panel markup, this only
 * supplies the open state, the two refs, and the two keydown handlers to
 * attach (to the trigger `<button>` and the panel container respectively).
 */
export function useDropdownMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const panelItems = (): HTMLButtonElement[] => {
    const root = rootRef.current;
    if (!root) return [];
    return Array.from(
      root.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    ).filter((el) => el !== triggerRef.current);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Moves focus into the panel's first item on open, however it was opened
  // (click or Up/Down on the trigger) — standard menu-button behavior.
  useEffect(() => {
    if (!open) return;
    panelItems()[0]?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onPanelKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") {
      return;
    }
    const items = panelItems();
    if (items.length === 0) return;
    e.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
    else next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return { open, setOpen, close, rootRef, triggerRef, onTriggerKeyDown, onPanelKeyDown };
}
