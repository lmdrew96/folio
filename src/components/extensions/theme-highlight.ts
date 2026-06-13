import { Highlight } from "@tiptap/extension-highlight";

/**
 * Theme-aware highlight. Stores a semantic name (amber/green/mint/lavender) as
 * a `data-highlight` attribute instead of a raw color, so CSS can render a
 * light tint + dark ink in light mode and a deep muted tint + light text in
 * dark mode. Without this the stored hex was a fixed light tint that washed out
 * the prose in dark mode.
 */
export const ThemeHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-highlight"),
        renderHTML: (attributes) =>
          attributes.color ? { "data-highlight": attributes.color } : {},
      },
    };
  },
});
