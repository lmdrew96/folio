"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import {
  SuperDocEditor as SuperDoc,
  type SuperDocReadyEvent,
} from "@superdoc-dev/react";
import "@superdoc-dev/react/style.css";
import { BlankDOCX } from "superdoc";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { registerPendingSaveFlush } from "@/lib/pendingSave";
import { toReconcileBlocks, type SdBlock, type SdProjection } from "@/superdoc/extract";

/** Built by scripts/build-superdoc-worker.mjs. */
const COLLAB_WORKER_URL = "/superdoc/collab-worker.js";
/** Quiet time after an edit before the derived block rows are rebuilt. */
const EXTRACT_DEBOUNCE_MS = 1000;
/** How long to wait before re-claiming a room another tab is still creating. */
const CLAIM_RETRY_MS = 2000;

type RoomMode = "create" | "join";
type Connection = "connecting" | "synced" | "degraded" | "failed";

/** The slice of SuperDoc's browser Document API this editor reads. */
type DocApi = {
  blocks: { list(input: unknown): Promise<{ blocks: SdBlock[] }> | { blocks: SdBlock[] } };
  projectMarkdown?(input: unknown): Promise<SdProjection>;
};

/**
 * A document edited in SuperDoc. Its Y.Doc lives in Convex (convex/ydoc.ts),
 * synced by the "convex" provider adapter inside SuperDoc's collaboration
 * worker (src/superdoc/). This component owns what the worker can't:
 *   - claiming the room (create vs join) before SuperDoc mounts,
 *   - rebuilding the derived `blocks` rows after edits settle, so the diff
 *     panel, attribution, Cleo and the MCP door keep working,
 *   - telling the writer when edits aren't reaching the server.
 */
export function SuperDocEditor({ documentId }: { documentId: Id<"documents"> }) {
  const { getToken } = useAuth();
  // SuperDoc rebuilds the editor when `document` changes, so the token
  // resolver it holds must be stable. Clerk's getToken is (a useCallback on
  // the Clerk instance) and always returns a current token.
  const fetchToken = useCallback(
    async () => (await getToken({ template: "convex" })) ?? "",
    [getToken],
  );

  const claimRoom = useMutation(api.ydoc.claimRoom);
  const reconcile = useMutation(api.blocks.reconcile);

  // ---- room claim (decided once, before SuperDoc mounts) ----
  const [roomMode, setRoomMode] = useState<RoomMode | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const claim = async () => {
      try {
        const result = await claimRoom({ documentId });
        if (cancelled) return;
        if (result === "wait") timer = setTimeout(() => void claim(), CLAIM_RETRY_MS);
        else setRoomMode(result);
      } catch (e) {
        console.error("Folio: couldn't open the SuperDoc room", e);
        if (!cancelled) setClaimError("This document couldn't be opened.");
      }
    };
    void claim();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [claimRoom, documentId]);

  const document = useMemo(
    () =>
      roomMode === null
        ? null
        : {
            type: "docx",
            // A room needs a base file; on join the Y.Doc's content replaces it.
            url: BlankDOCX,
            collaboration: {
              providerType: "extension" as const,
              adapterId: "convex",
              documentId,
              roomMode,
              providerOptions: { convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL! },
              token: fetchToken,
            },
          },
    [documentId, roomMode, fetchToken],
  );

  // ---- connection state → save pill + unload guard ----
  const [connection, setConnection] = useState<Connection>("connecting");
  const connectionRef = useRef<Connection>("connecting");
  const onConnection = (state: Connection) => {
    // Debug-level (hidden unless the console shows Verbose): the only way to
    // see what the worker reports, since a healthy session shows no UI at all.
    console.debug(`Folio: SuperDoc sync ${connectionRef.current} → ${state}`);
    connectionRef.current = state;
    setConnection(state);
  };
  const unsynced = connection === "degraded" || connection === "failed";

  useEffect(() => {
    if (!unsynced) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // some browsers still require this to show the prompt
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [unsynced]);

  // ---- derived block rows ----
  const docApiRef = useRef<DocApi | null>(null);
  const extractTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const extracting = useRef<Promise<void> | null>(null);
  const extractAgain = useRef(false);

  const extract = async (): Promise<void> => {
    if (extracting.current) {
      extractAgain.current = true; // an edit landed mid-run; go once more after
      return extracting.current;
    }
    const doc = docApiRef.current;
    if (!doc) return;
    extracting.current = (async () => {
      do {
        extractAgain.current = false;
        try {
          const [{ blocks }, projection] = await Promise.all([
            Promise.resolve(doc.blocks.list({ includeText: true, limit: 20_000 })),
            doc.projectMarkdown
              ? doc.projectMarkdown({}).catch((e: unknown) => {
                  // Formatting is a nice-to-have in the derived copy; text isn't.
                  console.error("Folio: markdown projection failed, saving plain text", e);
                  return null;
                })
              : Promise.resolve(null),
          ]);
          await reconcile({
            documentId,
            blocks: toReconcileBlocks(blocks, projection),
            source: "superdoc",
          });
        } catch (e) {
          // The Y.Doc (the real content) is unaffected; the derived rows catch
          // up on the next edit. Logged, not surfaced — nothing the writer can do.
          const code = e instanceof ConvexError ? (e.data as { code?: string })?.code : undefined;
          console.error(`Folio: block extraction failed${code ? ` (${code})` : ""}`, e);
        }
      } while (extractAgain.current);
    })();
    try {
      await extracting.current;
    } finally {
      extracting.current = null;
    }
  };

  const scheduleExtract = () => {
    clearTimeout(extractTimer.current);
    extractTimer.current = setTimeout(() => void extract(), EXTRACT_DEBOUNCE_MS);
  };

  // The update toast flushes through here before reloading. Edits themselves
  // live in the worker's Y.Doc; while the connection is down, a reload could
  // lose them, so report "not safe". ("connecting" before the first sync
  // holds no local edits yet, so it doesn't block a reload.)
  useEffect(
    () =>
      registerPendingSaveFlush(async () => {
        clearTimeout(extractTimer.current);
        await extract();
        return connectionRef.current !== "degraded" && connectionRef.current !== "failed";
      }),
    // extract reads refs only; registering once per document is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [documentId],
  );

  useEffect(
    () => () => {
      // Leaving the document: rebuild the rows one last time.
      if (extractTimer.current) {
        clearTimeout(extractTimer.current);
        void extract();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onReady = ({ superdoc }: SuperDocReadyEvent) => {
    docApiRef.current = (superdoc.activeEditor?.doc ?? null) as DocApi | null;
    void extract();
  };

  if (claimError) {
    return <p className="px-6 py-10 text-foreground/60">{claimError}</p>;
  }
  if (!document) {
    return <p className="px-6 py-10 text-foreground/50">Opening…</p>;
  }

  return (
    <div className="folio-superdoc flex min-h-0 flex-1 flex-col">
      <SuperDoc
        document={document}
        documentMode="editing"
        contained
        telemetry={{ enabled: false }}
        workerUrls={{ collaboration: COLLAB_WORKER_URL }}
        onReady={onReady}
        onEditorUpdate={scheduleExtract}
        onCollaborationConnectionChange={({ state }) => onConnection(state)}
        onException={(e) => console.error("Folio: SuperDoc exception", e)}
        className="min-h-0 flex-1"
      />
      {/* Same quiet pill the TipTap editor uses for its save story. */}
      <div
        className={`fixed bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-3 py-1 text-xs text-foreground shadow-sm transition-opacity duration-200 ${
          unsynced ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <span aria-live="polite">
          {connection === "failed"
            ? "Not saved — this document can't sync right now"
            : "Not saved — reconnecting…"}
        </span>
      </div>
    </div>
  );
}
