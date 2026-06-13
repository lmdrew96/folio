import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { relativeTime } from "@/lib/time";

export type AttrInfo = { author?: string; lastEditedAt: number };

/**
 * Carries the live blockId → attribution map into the editor. The map is pushed
 * in via a meta transaction (no doc change, so it never triggers a save), and
 * the plugin renders a per-block node decoration: a gutter dot colored by author
 * plus a native hover tooltip ("nae · edited 2m ago").
 */
export const attributionPluginKey = new PluginKey<Map<string, AttrInfo>>(
  "folioAttribution",
);

export const Attribution = Extension.create({
  name: "folioAttribution",

  addProseMirrorPlugins() {
    return [
      new Plugin<Map<string, AttrInfo>>({
        key: attributionPluginKey,
        state: {
          init: () => new Map<string, AttrInfo>(),
          apply(tr, value) {
            const next = tr.getMeta(attributionPluginKey) as
              | Map<string, AttrInfo>
              | undefined;
            return next ?? value;
          },
        },
        props: {
          decorations(state) {
            const map = attributionPluginKey.getState(state);
            if (!map || map.size === 0) return DecorationSet.empty;

            const decorations: Decoration[] = [];
            state.doc.forEach((node, offset) => {
              const id = node.attrs?.id as string | undefined;
              if (!id) return;
              const info = map.get(id);
              if (!info) return;
              const author = info.author ?? "nae";
              decorations.push(
                Decoration.node(offset, offset + node.nodeSize, {
                  class: "folio-attr",
                  "data-author": author,
                  title: `${author} · edited ${relativeTime(info.lastEditedAt)}`,
                }),
              );
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
