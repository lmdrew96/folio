import { Extension } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    folioFontSize: {
      setFontSize: (fontSize: string) => ReturnType;
      unsetFontSize: () => ReturnType;
    };
  }
}

/**
 * Free-form text size as a node attribute on paragraphs and headings,
 * rendered as an inline `font-size` style — same pattern as LineHeight.
 * Independent of heading level: a heading keeps its semantic tag (h1/h2/h3)
 * for structure/export/accessibility, but its visual size can be overridden
 * to anything, not just the 4 built-in tiers.
 */
export const FontSize = Extension.create({
  name: "folioFontSize",

  addOptions() {
    return { types: ["paragraph", "heading"] as string[] };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize || null,
            renderHTML: (attributes) =>
              attributes.fontSize ? { style: `font-size: ${attributes.fontSize}` } : {},
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
      setFontSize:
        (fontSize: string) =>
        ({ commands }) =>
          this.options.types
            .map((type: string) => commands.updateAttributes(type, { fontSize }))
            .some(Boolean),
      unsetFontSize:
        () =>
        ({ commands }) =>
          this.options.types
            .map((type: string) => commands.resetAttributes(type, "fontSize"))
            .some(Boolean),
    };
  },
});
