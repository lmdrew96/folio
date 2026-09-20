/**
 * CSS length/number normalizers for values that arrive from *outside* Folio.
 *
 * Folio's own block attributes are written in a single form each — `Npx` for
 * font size, a bare multiple for line height, `Nem` for indent — but a paste
 * from Word, Google Docs, or any web page carries whatever that document used
 * (`11pt`, `115%`, `0.5in`). The parseHTML handlers in
 * components/extensions/{font-size,line-height,indent}.ts run every pasted
 * value through here so a foreign unit can never reach a Convex block, an
 * export, or the toolbar's controls.
 *
 * Shared on purpose: three extensions need the same conversion table, and the
 * read side (the toolbar's size dial) needs it too for blocks that already
 * carry a foreign value from before this existed.
 */

/**
 * Absolute CSS length units → px. Relative units (`em`, `%`, `ex`, `ch`, and
 * the viewport units) are deliberately absent: they resolve against the
 * element's parent or the layout, neither of which a parseHTML handler can
 * see. Guessing at them would silently resize pasted text, so they're dropped
 * instead and the block falls back to its tier default.
 */
const PX_PER_UNIT: Record<string, number> = {
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  rem: 16, // the root element isn't restyled, so 1rem is the browser default
};

/** Split a CSS length into its number and unit. `unit` is `""` for a bare number. */
export function parseCssLength(
  value: string | null | undefined,
): { n: number; unit: string } | null {
  if (!value) return null;
  const match = /^\s*(-?\d*\.?\d+)\s*([a-z%]*)\s*$/i.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  return { n, unit: match[2].toLowerCase() };
}

/** A CSS length in px, or null when it isn't an absolute length we can resolve. */
export function cssLengthToPx(value: string | null | undefined): number | null {
  const length = parseCssLength(value);
  if (!length) return null;
  // A unitless length is only legal as zero; anything else is a malformed value.
  if (length.unit === "") return length.n === 0 ? 0 : null;
  const factor = PX_PER_UNIT[length.unit];
  if (factor === undefined) return null;
  return length.n * factor;
}

/** The window FontSizeControl's own commit() enforces. */
export const MIN_FONT_SIZE_PX = 6;
export const MAX_FONT_SIZE_PX = 160;

export function clampFontSizePx(px: number): number {
  return Math.min(MAX_FONT_SIZE_PX, Math.max(MIN_FONT_SIZE_PX, Math.round(px)));
}

/**
 * Any inline `font-size` as Folio's own `Npx`, or null to inherit the block
 * tier's default. Keeps the size dial honest: it's an `<input type="number">`,
 * and a browser renders a non-numeric value as an empty field — so a block
 * carrying `11pt` used to read as "no explicit size" in the toolbar while
 * visibly having one.
 */
export function normalizeFontSize(value: string | null | undefined): string | null {
  const px = cssLengthToPx(value);
  if (px === null || px <= 0) return null;
  return `${clampFontSizePx(px)}px`;
}

/**
 * A font size as the bare number the size dial shows, or "" for none. Accepts
 * whatever it's handed — a legacy block that already stored `11pt` still gets
 * a number in the field rather than blanking it.
 */
export function fontSizeToDialValue(value: string | null | undefined): string {
  const px = cssLengthToPx(value);
  if (px === null || px <= 0) return "";
  return String(clampFontSizePx(px));
}

/** The line-spacing menu's own values (LINE_SPACINGS in Toolbar.tsx). */
export const LINE_HEIGHT_STEPS = [1, 1.15, 1.5, 2];

/**
 * Any inline `line-height` as one of the spacing menu's values, or null for
 * Default. A pasted `115%` used to be stored verbatim, which check-marked
 * nothing in the menu even though the block plainly had a spacing applied.
 *
 * Absolute line-heights (`14pt`) are dropped: they only mean something
 * relative to the element's own font size, which isn't knowable here.
 */
export function normalizeLineHeight(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim().toLowerCase();
  const percent = /^(-?\d*\.?\d+)%$/.exec(raw);
  const multiple = percent
    ? Number(percent[1]) / 100
    : /^-?\d*\.?\d+$/.test(raw)
      ? Number(raw)
      : null; // `normal`, `inherit`, or an absolute length
  if (multiple === null || !Number.isFinite(multiple) || multiple <= 0) return null;
  const nearest = LINE_HEIGHT_STEPS.reduce((best, step) =>
    Math.abs(step - multiple) < Math.abs(best - multiple) ? step : best,
  );
  return String(nearest);
}
