/**
 * Folio's BlockNote schema — the defaults plus a per-selection font — and the
 * formatting toolbar that sets it.
 *
 * The font style stores a key from Folio's curated list (src/lib/fonts.ts),
 * not a CSS value, so it renders through the same font variables as the rest
 * of Folio. Text with no font style is in the document's font.
 */
import { BlockNoteSchema, defaultStyleSpecs } from "@blocknote/core";
import {
  createReactStyleSpec,
  FormattingToolbar,
  FormattingToolbarController,
  getFormattingToolbarItems,
  useActiveStyles,
  useBlockNoteEditor,
  useComponentsContext,
  usePortalElement,
} from "@blocknote/react";
import { FONT_OPTIONS, fontCssValue } from "@/lib/fonts";

const Font = createReactStyleSpec(
  { type: "font", propSchema: "string" },
  {
    render: ({ value, contentRef }) => (
      <span data-font={value} style={{ fontFamily: fontCssValue(value) }} ref={contentRef} />
    ),
  },
);

export const folioSchema = BlockNoteSchema.create({
  styleSpecs: { ...defaultStyleSpecs, font: Font },
});

/** The font menu: the document's own font first, then the curated list. */
function FontSelect() {
  const editor = useBlockNoteEditor(folioSchema);
  const Components = useComponentsContext();
  const portalElement = usePortalElement();
  const current = useActiveStyles(editor).font;
  if (!Components) return null;
  return (
    <Components.FormattingToolbar.Select
      className="bn-select folio-font-select"
      portalElement={portalElement}
      items={[
        {
          text: "Document font",
          icon: <span style={{ fontFamily: "var(--folio-prose-font)" }}>Aa</span>,
          isSelected: !current,
          onClick: () => {
            editor.removeStyles({ font: "" });
            editor.focus();
          },
        },
        ...FONT_OPTIONS.map((f) => ({
          text: f.label,
          icon: <span style={{ fontFamily: fontCssValue(f.key) }}>Aa</span>,
          isSelected: f.key === current,
          onClick: () => {
            editor.addStyles({ font: f.key });
            editor.focus();
          },
        })),
      ]}
    />
  );
}

/** Controls the always-visible row (components/EditorToolbar.tsx) already
 *  has; the selection bubble leaves them out so no control shows twice. */
const IN_STATIC_TOOLBAR = new Set([
  "blockTypeSelect",
  "boldStyleButton",
  "italicStyleButton",
  "underlineStyleButton",
  "strikeStyleButton",
  "createLinkButton",
]);

const FolioToolbar = () => {
  const rest = getFormattingToolbarItems().filter((item) => !IN_STATIC_TOOLBAR.has(String(item.key)));
  return (
    <FormattingToolbar>
      <FontSelect key="fontSelect" />
      {rest}
    </FormattingToolbar>
  );
};

/** The selection bubble: Folio's font menu plus what the static row doesn't
 *  carry (colors, alignment, nesting, table and file tools). Render inside
 *  BlockNoteView with `formattingToolbar={false}`. */
export const FolioFormattingToolbar = () => <FormattingToolbarController formattingToolbar={FolioToolbar} />;
