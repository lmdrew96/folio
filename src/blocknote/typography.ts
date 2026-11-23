/**
 * Folio's smart typography: dashes, an ellipsis, curly quotes and arrows.
 * BlockNote's editor (src/blocknote/extensions.ts) calls `smartTypography`
 * with the text just before the caret after each typed character; a non-null
 * result says how many trailing characters to replace and with what.
 *
 * Rule ORDER is the disambiguator: the first match wins.
 *
 * Dashes: `--` → en dash, a third hyphen → em dash (the en dash isn't an ASCII
 * hyphen, so the two rules can't collide).
 * Arrows build on that: `->` and `-->` (which is `–>` by the time `>` lands)
 * become →; `<-` becomes ← immediately, and a further hyphen is absorbed so
 * `<--` stays ←; `<->` / `<-->` become ↔; `=>` becomes ⇒.
 */

/** Characters after which a quote opens: start of block, whitespace, an
 *  opening bracket or quote, or a dash. Anything else closes it. */
const BEFORE_OPENING = String.raw`(?<=^|[\s([{“‘–—-])`;

type Rule = { find: RegExp; replace: string | ((m: RegExpExecArray) => string) };

const RULES: Rule[] = [
  { find: /–-$/, replace: "—" }, // en dash + hyphen → em dash
  { find: /--$/, replace: "–" }, // en dash
  { find: /\.\.\.$/, replace: "…" }, // ellipsis

  { find: /←>$/, replace: "↔" }, // <-> and <-->
  { find: /←[-–]$/, replace: "←" }, // <-- stays a single arrow
  { find: /<[-–]$/, replace: "←" },
  { find: /[-–—]>$/, replace: "→" }, // ->, -->, --->
  { find: /=>$/, replace: "⇒" },

  // Double quotes: opening after a boundary, closing everywhere else.
  { find: new RegExp(`${BEFORE_OPENING}"$`), replace: "“" },
  { find: /"$/, replace: "”" },

  // An apostrophe inside or right after a word — `don't`, `writers'` — first,
  // so `'quoted'` doesn't open with the wrong mark.
  { find: /(?<=[\p{L}\p{N}])'$/u, replace: "’" },
  { find: new RegExp(`${BEFORE_OPENING}'$`), replace: "‘" },
  { find: /'$/, replace: "’" },

  // Leading elision — `'90s`. Opened as ‘ above (indistinguishable at that
  // moment), corrected once a digit follows.
  { find: /‘(\d)$/, replace: (m) => `’${m[1]}` },
];

export type TypographyFix = { remove: number; insert: string };

export function smartTypography(beforeCaret: string): TypographyFix | null {
  for (const rule of RULES) {
    const m = rule.find.exec(beforeCaret);
    if (!m) continue;
    const insert = typeof rule.replace === "string" ? rule.replace : rule.replace(m);
    return { remove: m[0].length, insert };
  }
  return null;
}
