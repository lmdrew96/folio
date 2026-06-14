import { Extension } from "@tiptap/core";

const MAX_INDENT = 10;
const STEP_EM = 2; // visual width of one indent level

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    folioIndent: {
      indentBlock: () => ReturnType;
      outdentBlock: () => ReturnType;
    };
  }
}

/**
 * Block indentation as a numeric `indent` level on paragraphs and headings,
 * rendered as an inline `margin-left` (so it persists in the block JSON like
 * textAlign / lineHeight do). Tab/Shift-Tab drive it:
 *  - inside a list  → sink / lift the list item (preserve native nesting)
 *  - inside a code block → defer to CodeBlock's own tab handling
 *  - otherwise → step this block's indent level in / out
 * Tab is always consumed outside code blocks, so focus never escapes the editor
 * (the old behavior the "tab to indent" patch was filed against).
 */
export const Indent = Extension.create({
  name: "folioIndent",

  addOptions() {
    return { types: ["paragraph", "heading"] as string[] };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          indent: {
            default: null,
            parseHTML: (element) => {
              const ml = parseFloat(element.style.marginLeft);
              if (!ml) return null;
              return Math.min(MAX_INDENT, Math.max(1, Math.round(ml / STEP_EM)));
            },
            renderHTML: (attributes) =>
              attributes.indent
                ? { style: `margin-left: ${attributes.indent * STEP_EM}em` }
                : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      indentBlock:
        () =>
        ({ editor, commands }) =>
          this.options.types.some((type: string) => {
            if (!editor.isActive(type)) return false;
            const cur = (editor.getAttributes(type).indent as number) ?? 0;
            if (cur >= MAX_INDENT) return true; // capped, but still consume Tab
            return commands.updateAttributes(type, { indent: cur + 1 });
          }),
      outdentBlock:
        () =>
        ({ editor, commands }) =>
          this.options.types.some((type: string) => {
            if (!editor.isActive(type)) return false;
            const cur = (editor.getAttributes(type).indent as number) ?? 0;
            if (cur <= 0) return true; // nothing to outdent, but still consume Tab
            const next = cur - 1;
            return commands.updateAttributes(type, {
              indent: next === 0 ? null : next,
            });
          }),
    };
  },

  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        if (editor.isActive("codeBlock")) return false; // let code blocks tab
        if (editor.isActive("listItem")) {
          editor.commands.sinkListItem("listItem");
          return true;
        }
        editor.commands.indentBlock();
        return true;
      },
      "Shift-Tab": ({ editor }) => {
        if (editor.isActive("codeBlock")) return false;
        if (editor.isActive("listItem")) {
          editor.commands.liftListItem("listItem");
          return true;
        }
        editor.commands.outdentBlock();
        return true;
      },
    };
  },
});
