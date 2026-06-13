import { Extension, textInputRule } from "@tiptap/core";

/**
 * Folio's smart typography — writerly input rules that fire as you type.
 *
 * Nae's dash convention (matches most prose editors): `--` becomes an en dash,
 * a third hyphen turns it into an em dash. The two rules don't collide because
 * the en dash (U+2013) isn't an ASCII hyphen, so once `--` → "–", the only rule
 * that can match the next hyphen is the en-dash-plus-hyphen one.
 *
 * All of these are automatically skipped inside code blocks and inline code —
 * TipTap's input-rule runner bails on `code` nodes/marks before any rule runs,
 * so `--noEmit` and friends stay literal.
 */
export const SmartTypography = Extension.create({
  name: "folioSmartTypography",

  addInputRules() {
    return [
      textInputRule({ find: /--$/, replace: "–" }), // en dash
      textInputRule({ find: /–-$/, replace: "—" }), // en dash + hyphen → em dash
      textInputRule({ find: /\.\.\.$/, replace: "…" }), // ellipsis
    ];
  },
});
