"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useDropdownMenu } from "@/lib/useDropdownMenu";

/**
 * "Ask for one short string, validate it, apply or clear" — the in-page
 * replacement for window.prompt (link URL, word goal). Built on
 * useDropdownMenu for open state, outside-click close and Escape-returns-focus.
 *
 * The panel is role="dialog", not "menu": it holds a labelled text field and a
 * form, which a menu can't honestly contain. useRovingToolbar skips dialogs as
 * well as menus, so the field keeps its own arrow/Home/End keys.
 *
 * A blank submit means "clear", matching the old prompt behaviour.
 */
export function InputPopover({
  label,
  trigger,
  triggerClassName,
  active,
  fieldLabel,
  placeholder,
  inputMode,
  initialValue,
  validate,
  onApply,
  onClear,
  clearLabel,
  canClear,
  placement = "below",
  onOpen,
  refocusTrigger = true,
}: {
  /** Accessible name + tooltip for the trigger, and the dialog's name. */
  label: string;
  trigger: ReactNode;
  triggerClassName: string;
  active?: boolean;
  fieldLabel: string;
  placeholder?: string;
  inputMode?: "url" | "numeric" | "text";
  /** Read when the popover opens, so it always reflects the current value. */
  initialValue: () => string;
  /** Returns an error message, or null when the (non-blank) value is fine. */
  validate: (value: string) => string | null;
  onApply: (value: string) => void;
  onClear: () => void;
  clearLabel: string;
  /** Whether there's anything to clear — shows the clear button. */
  canClear: boolean;
  placement?: "below" | "above";
  /** Runs just before opening — e.g. to capture the editor selection. */
  onOpen?: () => void;
  /** After apply/clear, return focus to the trigger. Off when onApply moves
   *  focus itself (the link popover hands it back to the editor). */
  refocusTrigger?: boolean;
}) {
  const { open, setOpen, close, rootRef, triggerRef, onTriggerKeyDown, onPanelKeyDown } =
    useDropdownMenu();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const errorId = useId();

  // Declared after useDropdownMenu's own open effect (which focuses the first
  // button), so the text field wins focus.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  const openPopover = () => {
    onOpen?.();
    setValue(initialValue());
    setError(null);
    setOpen(true);
  };

  const finish = () => {
    if (refocusTrigger) close();
    else setOpen(false);
  };

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed === "") {
      onClear();
      finish();
      return;
    }
    const problem = validate(trimmed);
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
      return;
    }
    onApply(trimmed);
    finish();
  };

  // Only Escape goes to the shared handler from inside the field — its
  // Up/Down/Home/End roving would steal the caret keys a text field needs.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).tagName === "INPUT" && e.key !== "Escape") return;
    onPanelKeyDown(e);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        // Keep the editor's text selection — don't let the button steal focus.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (open ? setOpen(false) : openPopover())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openPopover();
            return;
          }
          onTriggerKeyDown(e);
        }}
        aria-label={label}
        aria-pressed={active}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={label}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={label}
          onKeyDown={onKeyDown}
          className={`absolute left-0 z-30 w-72 rounded-lg border border-foreground/10 bg-[var(--folio-paper)] p-2 shadow-md print:hidden ${
            placement === "above" ? "bottom-9" : "top-9"
          }`}
        >
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="flex flex-col gap-1.5"
          >
            <label htmlFor={fieldId} className="text-xs text-foreground/50">
              {fieldLabel}
            </label>
            <input
              ref={inputRef}
              id={fieldId}
              type="text"
              inputMode={inputMode}
              autoComplete="off"
              spellCheck={false}
              value={value}
              placeholder={placeholder}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              className="w-full rounded-md border border-foreground/15 bg-transparent px-2 py-1 text-sm text-foreground outline-none placeholder:text-foreground/35 focus:ring-2 focus:ring-[var(--folio-attr-sibling)]"
            />
            {error && (
              <p id={errorId} role="alert" className="text-xs text-foreground/80">
                {error}
              </p>
            )}
            <div className="flex items-center justify-end gap-1">
              {canClear && (
                <button
                  type="button"
                  onClick={() => {
                    onClear();
                    finish();
                  }}
                  className="mr-auto rounded px-2 py-1 text-xs text-foreground/60 transition hover:text-foreground"
                >
                  {clearLabel}
                </button>
              )}
              <button
                type="button"
                onClick={close}
                className="rounded px-2 py-1 text-xs text-foreground/60 transition hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-md bg-black/5 px-2.5 py-1 text-xs font-medium text-foreground transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
              >
                Apply
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
