"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

/** Creates a fresh document and drops the writer straight into it — filed
 *  into `folderId` when made from inside a folder. */
export function NewDocButton({
  className,
  folderId,
}: {
  className?: string;
  folderId?: Id<"folders">;
}) {
  const create = useMutation(api.documents.create);
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async (editor?: "superdoc") => {
    setLoading(true);
    setError(null);
    try {
      const id = await create({ folderId, editor });
      router.push(`/doc/${id}`);
    } catch (e) {
      setLoading(false);
      setError(e instanceof Error ? e.message : "Couldn't create a document");
    }
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        onClick={() => void onClick()}
        disabled={loading}
        className={
          className ??
          "rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        }
      >
        {loading ? "Creating…" : "New document"}
      </button>
      {/* SuperDoc migration (phase 2): dev-only until the new editor ships.
          NODE_ENV is inlined at build time, so this is absent from prod. */}
      {process.env.NODE_ENV === "development" && (
        <button
          onClick={() => void onClick("superdoc")}
          disabled={loading}
          className="text-xs text-foreground/50 underline decoration-foreground/20 underline-offset-2 transition hover:text-foreground disabled:opacity-50"
        >
          New SuperDoc document (dev)
        </button>
      )}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
