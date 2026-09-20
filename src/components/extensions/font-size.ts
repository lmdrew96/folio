import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { normalizeFontSize } from "@/lib/cssUnits";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    folioFontSize: {
      setFontSize: (fontSize: string) => ReturnType;
      unsetFontSize: () => ReturnType;
    };
  }
}

/**
 * Each block tier's rendered default size when it carries no explicit
 * override — mirrors the `.ProseMirror p` / `.ProseMirror h1..h4` rules in
 * globals.css. Keep the two in sync: these are the numbers the toolbar's size
 * dial reports and the list-marker decoration below applies, those are what
 * the page actually paints.
 */
export const DEFAULT_FONT_SIZE = "11px";
export const HEADING_FONT_SIZES: Record<number, string> = {
  1: "20px",
  2: "16px",
  3: "14px",
  4: "12px",
};

/** The size a block really renders at: its own override, else its tier's default. */
export function blockFontSize(node: PMNode): string {
  const own = node.attrs?.fontSize;
  if (typeof own === "string" && own) return own;
  if (node.type.name === "heading") {
    return HEADING_FONT_SIZES[node.attrs?.level as number] ?? DEFAULT_FONT_SIZE;
  }
  return DEFAULT_FONT_SIZE;
}

const listMarkerSizeKey = new PluginKey("folioListMarkerSize");

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
            // Normalized, never taken at face value: a paste from Word or
            // Docs arrives as `11pt`/`1.1em`, and Folio's own attribute is
            // always `Npx` (see lib/cssUnits.ts for why relative units are
            // dropped rather than guessed at).
            parseHTML: (element) => normalizeFontSize(element.style.fontSize),
            renderHTML: (attributes) =>
              attributes.fontSize ? { style: `font-size: ${attributes.fontSize}` } : {},
          },
        },
      },
    ];
  },

  // A list marker (the ::marker glyph or the ordered counter) is sized by its
  // <li>, never by the line's own text — so a bullet whose text was resized to
  // 30px kept an 18px bullet beside it, with nothing in the toolbar able to
  // change it. Mirror the item's first line's rendered size onto the <li>.
  //
  // Deliberately a node decoration and not a `fontSize` attribute on listItem:
  // this is derived state, so it can't drift out of sync with the line it
  // describes, it needs no migration, and it doesn't rewrite every existing
  // list block in Convex (which would have shown up as a phantom "edited" in
  // the diff panel) just to record a number we can already compute.
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: listMarkerSizeKey,
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              const name = node.type.name;
              if (name === "listItem") {
                const first = node.firstChild;
                if (first) {
                  decorations.push(
                    Decoration.node(pos, pos + node.nodeSize, {
                      style: `font-size: ${blockFontSize(first)}`,
                    }),
                  );
                }
                return true; // keep descending — nested lists live in here
              }
              // Nothing else can contain a listItem, so don't walk the prose.
              return name === "bulletList" || name === "orderedList";
            });
            if (decorations.length === 0) return DecorationSet.empty;
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
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
