import { Extension } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

const plainPasteKey = new PluginKey("folioPlainPaste");

/**
 * How long a Cmd/Ctrl+Shift+V keypress stays armed. The browser fires the
 * paste event immediately after the keydown, so this only exists to disarm the
 * flag if no paste ever arrives (an empty clipboard, or a platform that
 * swallows the shortcut) — otherwise the *next* ordinary paste would be
 * stripped instead.
 */
const ARM_WINDOW_MS = 200;

/**
 * Cmd/Ctrl+Shift+V — paste the clipboard's plain text and drop the source
 * document's formatting entirely.
 *
 * The direct answer to pasting out of Word or Google Docs, where the useful
 * thing is the words and the rest is that document's type scale. Folio's
 * parseHTML handlers normalize a formatted paste's units (lib/cssUnits.ts),
 * but a writer who wants their own page's styling shouldn't have to clean up
 * after the paste at all.
 *
 * Implemented as a ProseMirror plugin rather than a Tiptap keyboard shortcut
 * because only `handleKeyDown` sees the modifier state — a `ClipboardEvent`
 * carries no shiftKey, so the keypress has to arm the flag that `handlePaste`
 * then reads.
 */
export const PlainPaste = Extension.create({
  name: "folioPlainPaste",

  addProseMirrorPlugins() {
    let armed = false;
    let disarm: ReturnType<typeof setTimeout> | null = null;

    return [
      new Plugin({
        key: plainPasteKey,
        props: {
          handleKeyDown(_view, event) {
            if (
              (event.metaKey || event.ctrlKey) &&
              event.shiftKey &&
              !event.altKey &&
              (event.key === "v" || event.key === "V")
            ) {
              armed = true;
              if (disarm) clearTimeout(disarm);
              disarm = setTimeout(() => {
                armed = false;
                disarm = null;
              }, ARM_WINDOW_MS);
            }
            // Never consume the key — the browser still has to fire the paste.
            return false;
          },

          handlePaste: (_view, event) => {
            if (!armed) return false;
            armed = false;
            if (disarm) {
              clearTimeout(disarm);
              disarm = null;
            }

            const text = event.clipboardData?.getData("text/plain") ?? "";
            // Still consumed: the writer asked for the plain text, and letting
            // the formatted branch run as a fallback would be the opposite.
            if (!text) return true;

            // Trailing blank lines are an artifact of how the source app
            // copied, not content — Word and Docs both add one.
            const lines = text.split(/\r\n|\r|\n/);
            while (lines.length > 1 && lines[lines.length - 1].trim() === "") {
              lines.pop();
            }

            // A single line inserts inline so a mid-sentence paste stays in the
            // sentence. Built as a text node rather than passed as a string:
            // insertContent parses a string as HTML, which would re-introduce
            // markup from text that merely contains angle brackets.
            const content: JSONContent[] =
              lines.length === 1
                ? [{ type: "text", text: lines[0] }]
                : lines.map((line) =>
                    line === ""
                      ? { type: "paragraph" }
                      : { type: "paragraph", content: [{ type: "text", text: line }] },
                  );

            this.editor.commands.insertContent(content);
            return true;
          },
        },
      }),
    ];
  },
});
