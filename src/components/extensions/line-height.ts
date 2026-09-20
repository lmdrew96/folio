import { Extension } from "@tiptap/core";
import { normalizeLineHeight } from "@/lib/cssUnits";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    folioLineHeight: {
      setLineHeight: (lineHeight: string) => ReturnType;
      unsetLineHeight: () => ReturnType;
    };
  }
}

/**
 * Line spacing as a node attribute on paragraphs and headings, rendered as an
 * inline `line-height` style (so it overrides the prose defaults and persists
 * in the block JSON like textAlign does).
 */
export const LineHeight = Extension.create({
  name: "folioLineHeight",

  addOptions() {
    return { types: ["paragraph", "heading"] as string[] };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          lineHeight: {
            default: null,
            // Snapped to one of the spacing menu's own values, so a pasted
            // `115%` can't apply a spacing the control then shows as unset.
            parseHTML: (element) => normalizeLineHeight(element.style.lineHeight),
            renderHTML: (attributes) =>
              attributes.lineHeight
                ? { style: `line-height: ${attributes.lineHeight}` }
                : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      // .map(...).some(Boolean) instead of .every(...): the selection is only
      // ever inside ONE of these types at a time, and .every() stops at the
      // first false — so with "paragraph" listed before "heading", applying
      // this from inside a heading (where the paragraph check always fails)
      // never even reached the heading check. .map() always visits every
      // type; .some() just asks whether any of them actually applied.
      setLineHeight:
        (lineHeight: string) =>
        ({ commands }) =>
          this.options.types
            .map((type: string) => commands.updateAttributes(type, { lineHeight }))
            .some(Boolean),
      unsetLineHeight:
        () =>
        ({ commands }) =>
          this.options.types
            .map((type: string) => commands.resetAttributes(type, "lineHeight"))
            .some(Boolean),
    };
  },
});
