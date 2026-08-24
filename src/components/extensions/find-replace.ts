import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export type FindMatch = { from: number; to: number };
export type FindState = { matches: FindMatch[]; active: number };

const EMPTY_STATE: FindState = { matches: [], active: -1 };

/** Renders the FindReplace bar's current match set as inline decorations —
 *  all matches tinted, the active one distinct. The bar owns match-finding
 *  and pushes the result in via a meta transaction; this plugin only paints. */
export const findReplacePluginKey = new PluginKey<FindState>("folioFindReplace");

export const FindReplace = Extension.create({
  name: "folioFindReplace",

  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findReplacePluginKey,
        state: {
          init: () => EMPTY_STATE,
          apply(tr, value) {
            const next = tr.getMeta(findReplacePluginKey) as FindState | undefined;
            return next ?? value;
          },
        },
        props: {
          decorations(state) {
            const { matches, active } = findReplacePluginKey.getState(state) ?? EMPTY_STATE;
            if (matches.length === 0) return DecorationSet.empty;
            const decorations = matches.map((m, i) =>
              Decoration.inline(m.from, m.to, {
                class:
                  i === active
                    ? "folio-find-match folio-find-match-active"
                    : "folio-find-match",
              }),
            );
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
