"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";

/** Creates a fresh document and drops the writer straight into it. */
export function NewDocButton({ className }: { className?: string }) {
  const create = useMutation(api.documents.create);
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    setLoading(true);
    setError(null);
    try {
      const id = await create();
      router.push(`/doc/${id}`);
    } catch (e) {
      setLoading(false);
      setError(e instanceof Error ? e.message : "Couldn't create a document");
    }
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        onClick={onClick}
        disabled={loading}
        className={
          className ??
          "rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        }
      >
        {loading ? "Creating…" : "New document"}
      </button>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
