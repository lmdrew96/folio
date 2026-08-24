// Folio's curated prose-font list — 4 serif, 4 sans, 2 mono. Each entry's
// `variable` matches a CSS custom property loaded once in layout.tsx via
// next/font/google; picking a font just swaps which one --folio-prose-font
// resolves to (see globals.css), no per-font code path needed elsewhere.
export type FontOption = {
  key: string; // stored on documents.fontFamily
  label: string;
  category: "serif" | "sans" | "mono";
  variable: string; // CSS custom property name, e.g. "--font-fraunces"
  fallback: string; // generic fallback if the variable is somehow unset
};

export const FONT_OPTIONS: FontOption[] = [
  { key: "fraunces", label: "Fraunces", category: "serif", variable: "--font-fraunces", fallback: "Georgia, serif" },
  { key: "newsreader", label: "Newsreader", category: "serif", variable: "--font-newsreader", fallback: "Georgia, serif" },
  { key: "lora", label: "Lora", category: "serif", variable: "--font-lora", fallback: "Georgia, serif" },
  { key: "source-serif", label: "Source Serif", category: "serif", variable: "--font-source-serif", fallback: "Georgia, serif" },

  { key: "space-grotesk", label: "Space Grotesk", category: "sans", variable: "--font-space-grotesk", fallback: "system-ui, sans-serif" },
  { key: "inter", label: "Inter", category: "sans", variable: "--font-inter", fallback: "system-ui, sans-serif" },
  { key: "work-sans", label: "Work Sans", category: "sans", variable: "--font-work-sans", fallback: "system-ui, sans-serif" },
  { key: "manrope", label: "Manrope", category: "sans", variable: "--font-manrope", fallback: "system-ui, sans-serif" },

  { key: "geist-mono", label: "Geist Mono", category: "mono", variable: "--font-geist-mono", fallback: "ui-monospace, monospace" },
  { key: "jetbrains-mono", label: "JetBrains Mono", category: "mono", variable: "--font-jetbrains-mono", fallback: "ui-monospace, monospace" },
];

export const DEFAULT_FONT_KEY = "fraunces";

export function fontOption(key: string | undefined): FontOption {
  return FONT_OPTIONS.find((f) => f.key === key) ?? FONT_OPTIONS[0];
}

/** CSS `font-family` value for a stored font key, ready to assign to
 *  --folio-prose-font. Falls back to the default (Fraunces) for an unknown
 *  or missing key. */
export function fontCssValue(key: string | undefined): string {
  const opt = fontOption(key);
  return `var(${opt.variable}), ${opt.fallback}`;
}
