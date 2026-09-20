"use client";

import { useCallback, useEffect, useRef, type FocusEvent, type KeyboardEvent, type RefObject } from "react";

/**
 * Only buttons and links rove. The block-type `<select>` and the font-size
 * number input keep their natural tab stop and their native arrow keys —
 * arrows change a select's value and step a number field, so intercepting them
 * would break the control, and excluding them from the roving set without
 * leaving them tabbable would strand a keyboard user inside one with no way
 * back to the buttons. WAI-ARIA's toolbar pattern explicitly allows a
 * text-entry control to be its own tab stop for this reason.
 */
const ROVING_SELECTOR = "button, a[href]";

/**
 * Roving tabindex for a `role="toolbar"` container.
 *
 * The role is a promise: the group is one tab stop, and the arrow keys move
 * between its controls. Declaring it without delivering that makes a keyboard
 * user's model of the page *worse* than a plain div would — so the role and
 * this hook belong together.
 *
 * Controls are read from the DOM at the moment they're needed rather than
 * threaded through every child. Folio's toolbar mixes plain buttons, a select,
 * a number input and several popover triggers, and which of them exist changes
 * with the breakpoint and with what's open; a live query is always right where
 * a prop would drift.
 */
export function useRovingToolbar(rootRef: RefObject<HTMLElement | null>) {
  const activeRef = useRef(0);

  const items = useCallback((): HTMLElement[] => {
    const root = rootRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(ROVING_SELECTOR)).filter(
      (el) =>
        !el.hasAttribute("disabled") &&
        // An open popover's items are the menu's own business — useDropdownMenu
        // roves those with Up/Down. Only the toolbar row itself roves here.
        !el.closest('[role="menu"]') &&
        // Whatever the current breakpoint has collapsed into the More menu.
        el.offsetParent !== null,
    );
  }, [rootRef]);

  const focusTabStop = useCallback(
    (list: HTMLElement[], index: number) => {
      activeRef.current = index;
      list.forEach((el, i) => {
        el.tabIndex = i === index ? 0 : -1;
      });
    },
    [],
  );

  const apply = useCallback(() => {
    const list = items();
    if (list.length === 0) return;
    // Clamped: the set shrinks when the layout folds controls into More.
    focusTabStop(list, Math.min(activeRef.current, list.length - 1));
  }, [items, focusTabStop]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    apply();
    // A control that appears later — a breakpoint change, a popover opening —
    // would otherwise arrive as its own tab stop and break the single-stop
    // promise. Only childList is observed, so writing tabIndex can't re-trigger
    // this.
    const observer = new MutationObserver(apply);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [rootRef, apply]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") {
      return;
    }
    const target = e.target as HTMLElement;
    // Let a text-entry control and an open menu keep their own keys.
    if (target.closest('input, textarea, select, [role="menu"]')) return;
    const list = items();
    if (list.length === 0) return;
    const current = list.indexOf(target);
    const from = current === -1 ? activeRef.current : current;
    const next =
      e.key === "ArrowRight"
        ? (from + 1) % list.length
        : e.key === "ArrowLeft"
          ? (from - 1 + list.length) % list.length
          : e.key === "Home"
            ? 0
            : list.length - 1;
    e.preventDefault();
    focusTabStop(list, next);
    list[next].focus();
  };

  // Keep the tab stop on whatever the writer actually used last, so leaving the
  // toolbar and coming back returns to the same control.
  const onFocus = (e: FocusEvent<HTMLElement>) => {
    const list = items();
    const index = list.indexOf(e.target as HTMLElement);
    if (index !== -1) focusTabStop(list, index);
  };

  return { onKeyDown, onFocus };
}
