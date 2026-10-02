/**
 * Folio's smart typography for the SuperDoc editor — the same writerly rules
 * as the TipTap editor's input rules (components/extensions/typography.ts),
 * plus arrows (ChaosPatch "ensure arrows render").
 *
 * SuperDoc has no input-rule hook, so the editor calls `smartTypography` with
 * the text just before the caret after each local edit; a non-null result
 * says how many trailing characters to replace and with what.
 *
 * Rule ORDER is the disambiguator — the first match wins, exactly like the
 * TipTap input-rule runner.
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

/**
 * Replay `typed` (the characters the writer typed since the last check) on top
 * of `prefix` (the text before them), one character at a time, applying the
 * rules exactly as if each had been checked the moment it was typed. Returns
 * where the result first differs from what's actually in the document and
 * what should replace everything from there to the caret — or null if nothing
 * changes.
 */
export function replayTyping(
  prefix: string,
  typed: string,
): { from: number; insert: string } | null {
  let text = prefix;
  for (const ch of typed) {
    text += ch;
    const fix = smartTypography(text);
    if (fix) text = text.slice(0, text.length - fix.remove) + fix.insert;
  }
  const actual = prefix + typed;
  if (text === actual) return null;
  let from = 0;
  while (from < text.length && from < actual.length && text[from] === actual[from]) from++;
  return { from, insert: text.slice(from) };
}

export function smartTypography(beforeCaret: string): TypographyFix | null {
  for (const rule of RULES) {
    const m = rule.find.exec(beforeCaret);
    if (!m) continue;
    const insert = typeof rule.replace === "string" ? rule.replace : rule.replace(m);
    return { remove: m[0].length, insert };
  }
  return null;
}
