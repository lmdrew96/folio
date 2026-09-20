import { Extension, InputRule, textInputRule } from "@tiptap/core";

/**
 * Characters after which a quote is an *opening* one: nothing (start of the
 * block), whitespace, an opening bracket, an opening quote, or a dash. After
 * anything else — a letter, a digit, punctuation — it closes.
 */
const BEFORE_OPENING = String.raw`(?<=^|[\s([{“‘–—-])`;

/**
 * Folio's smart typography — writerly input rules that fire as you type.
 *
 * Nae's dash convention (matches most prose editors): `--` becomes an en dash,
 * a third hyphen turns it into an em dash. The two rules don't collide because
 * the en dash (U+2013) isn't an ASCII hyphen, so once `--` → "–", the only rule
 * that can match the next hyphen is the en-dash-plus-hyphen one.
 *
 * Quotes curl directionally off the preceding character, via lookbehind rather
 * than a capture group: TipTap's `textInputRule` treats `match[1]` as trailing
 * text to preserve and shifts the replacement range by it, so a captured
 * "previous character" would land the new glyph in the wrong place. A
 * lookbehind keeps `match[0]` to just the typed quote, which is exactly the
 * range the rule should replace.
 *
 * Rule ORDER is the disambiguator — the input-rule runner takes the first rule
 * that matches and stops. So the apostrophe rule has to precede the
 * opening-single-quote rule, and both have to precede the catch-all.
 *
 * All of these are automatically skipped inside code blocks and inline code —
 * TipTap's input-rule runner bails on `code` nodes/marks before any rule runs,
 * so `--noEmit` and `"quoted strings"` in code stay literal.
 */
export const SmartTypography = Extension.create({
  name: "folioSmartTypography",

  addInputRules() {
    return [
      textInputRule({ find: /--$/, replace: "–" }), // en dash
      textInputRule({ find: /–-$/, replace: "—" }), // en dash + hyphen → em dash
      textInputRule({ find: /\.\.\.$/, replace: "…" }), // ellipsis

      // Double quotes: opening after a boundary, closing everywhere else.
      textInputRule({ find: new RegExp(`${BEFORE_OPENING}"$`), replace: "“" }),
      textInputRule({ find: /"$/, replace: "”" }),

      // An apostrophe inside or right after a word — `don't`, `writers'`. This
      // has to come first: those are the same character as a closing single
      // quote and want the same glyph, and testing for a word character before
      // it is what keeps `'quoted'` from opening with the wrong mark.
      textInputRule({ find: /(?<=[\p{L}\p{N}])'$/u, replace: "’" }),
      textInputRule({ find: new RegExp(`${BEFORE_OPENING}'$`), replace: "‘" }),
      textInputRule({ find: /'$/, replace: "’" }),

      // Leading elision — `'90s`, not `‘90s`. Nothing can tell these apart at
      // the moment the quote is typed (an opening single quote sits in exactly
      // the same place), so the rule above opens it and this one corrects it
      // once a digit follows. A raw InputRule because the replacement has to
      // carry that digit through, which `textInputRule`'s static string can't.
      new InputRule({
        find: /‘(\d)$/,
        handler: ({ state, range, match }) => {
          state.tr.insertText(`’${match[1]}`, range.from, range.to);
        },
      }),
    ];
  },
});
