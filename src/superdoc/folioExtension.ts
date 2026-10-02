import { defineSuperDocExtension } from "superdoc";

/**
 * Folio's SuperDoc extension: what Folio paints into the document surface.
 *
 * Attribution: each top-level block gets a block decoration carrying who last
 * edited it and when. SuperDoc stamps it as the `folio-attr` class plus
 * `data-superdoc-ext-folio-{author,name,edited}`, owns the paint (so it
 * survives repaints and re-layouts), and globals.css draws the marginal tick.
 * SuperDoc only decorates the paginated layout; SuperDocEditor mirrors the
 * same attributes onto the continuous layout's blocks itself.
 *
 * The data lives in React (a Convex query), the extension inside SuperDoc —
 * `FolioBridge` is the one object both hold. The editor pushes into it; the
 * extension applies whatever it has once SuperDoc is ready.
 */

export type BlockAttribution = {
  blockId: string;
  /** Length of the block's visible text — a decoration needs a text range. */
  length: number;
  author: string;
  name: string;
  lastEditedAt: number;
};

type SelectionHandler = (event: { blockId: string | null; collapsed: boolean }) => void;
/** Called on every document change, whatever its origin. */
type MutationHandler = () => void;

export type FolioBridge = {
  setAttribution(blocks: BlockAttribution[]): void;
  setSelectionHandler(handler: SelectionHandler | null): void;
  setMutationHandler(handler: MutationHandler | null): void;
};

/** A bridge plus the extension bound to it — one pair per mounted editor. */
export function createFolioExtension() {
  let apply: ((blocks: BlockAttribution[]) => void) | null = null;
  let pending: BlockAttribution[] | null = null;
  let onSelection: SelectionHandler | null = null;
  let onMutation: MutationHandler | null = null;

  const bridge: FolioBridge = {
    setAttribution(blocks) {
      pending = blocks;
      apply?.(blocks);
    },
    setSelectionHandler(handler) {
      onSelection = handler;
    },
    setMutationHandler(handler) {
      onMutation = handler;
    },
  };

  const extension = defineSuperDocExtension({
    id: "folio.core",
    activate(ctx) {
      const ticks = ctx.visuals.decorate("attribution", {
        scope: "block",
        className: "folio-attr",
      });
      apply = (blocks) => {
        ticks.replace(
          blocks
            // Decorations anchor to text; an empty paragraph has nothing to
            // anchor to and nothing to attribute, so it carries no tick.
            .filter((b) => b.length > 0)
            .map((b) => ({
              target: { kind: "text" as const, blockId: b.blockId, range: { start: 0, end: b.length } },
              data: {
                "folio-author": b.author === "claude" ? "claude" : "human",
                "folio-name": b.name,
                "folio-edited": b.lastEditedAt,
              },
            })),
        );
      };
      if (pending) apply(pending);

      const selection = ctx.onSelection((e) =>
        onSelection?.({ blockId: e.blockId, collapsed: e.collapsed }),
      );
      // All changes, including style-only ones (a paragraph turned into a
      // heading) that SuperDoc's onEditorUpdate doesn't report.
      const mutation = ctx.onMutation({}, () => onMutation?.());
      return [
        selection,
        mutation,
        {
          dispose() {
            apply = null;
            ticks.dispose();
          },
        },
      ];
    },
  });

  return { bridge, extension };
}
