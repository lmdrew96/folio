/**
 * SuperDoc's collaboration worker, with Folio's Convex provider adapter.
 *
 * SuperDoc v2 owns its Y.Doc inside this worker and refuses an app-supplied
 * one, so custom backends plug in as a named provider adapter. The editor
 * selects it with
 *   collaboration: { providerType: "extension", adapterId: "convex",
 *                    documentId, roomMode, providerOptions: { convexUrl }, token }
 * and `workerUrls.collaboration` pointing at the built file.
 *
 * Built by scripts/build-superdoc-worker.mjs into public/superdoc/ (not
 * bundled by Next, since SuperDoc spawns it from a URL).
 */
import { bootstrapSuperDocCollaborationWorker } from "superdoc/collaboration-worker";
import { ConvexClient } from "convex/browser";
import type { Id } from "../../convex/_generated/dataModel";
import { attachConvexSync } from "./convexProvider";

type ProviderOptions = { convexUrl: string };

bootstrapSuperDocCollaborationWorker({
  providerAdapters: {
    convex: ({ documentId, providerOptions, token }) => ({
      // SuperDoc requires a built-in family name; the transport is ours.
      providerFamily: "y-websocket",
      attach({ ydoc, onSynced, onDegraded, onFailed }) {
        const { convexUrl } = providerOptions as ProviderOptions;
        const client = new ConvexClient(convexUrl);
        // `token` proxies to the page's Clerk getToken, which returns a fresh
        // token once the cached one expires — so re-auth after expiry works.
        client.setAuth(async () =>
          typeof token === "function" ? await token() : (token ?? null),
        );
        const sync = attachConvexSync({
          client,
          documentId: documentId as Id<"documents">,
          ydoc,
          callbacks: { onSynced, onDegraded, onFailed },
        });
        const close = () => void sync.destroy();
        return { disconnect: close, destroy: close };
      },
    }),
  },
});
