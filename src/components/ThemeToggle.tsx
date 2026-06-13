"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTheme } from "next-themes";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
const SunIcon = (
  <Icon>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Icon>
);
const MoonIcon = (
  <Icon>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </Icon>
);
const MonitorIcon = (
  <Icon>
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </Icon>
);
const CheckIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const OPTIONS = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
] as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // next-themes only knows the theme after mount — gate on this to avoid a
  // hydration mismatch on the active icon/checkmark.
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const current = OPTIONS.find((o) => o.value === theme) ?? OPTIONS[0];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Theme"
        aria-expanded={open}
        title="Theme"
        className="flex h-8 w-8 items-center justify-center rounded-md text-foreground/60 transition hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
      >
        {mounted ? current.icon : MonitorIcon}
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-40 w-36 overflow-hidden rounded-lg border border-foreground/10 bg-[var(--folio-paper)] py-1 shadow-md">
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => {
                setTheme(o.value);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm transition hover:bg-black/5 dark:hover:bg-white/10 ${
                mounted && theme === o.value
                  ? "text-foreground"
                  : "text-foreground/60"
              }`}
            >
              <span className="flex h-4 w-4 items-center justify-center">
                {o.icon}
              </span>
              <span className="flex-1 text-left">{o.label}</span>
              {mounted && theme === o.value && CheckIcon}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
