"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";

export function OpenDocButton() {
  const getOrCreate = useMutation(api.documents.getOrCreateDefault);
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setLoading(true);
    setError(null);
    try {
      const id = await getOrCreate();
      router.push(`/doc/${id}`);
    } catch (e) {
      setLoading(false);
      setError(e instanceof Error ? e.message : "Something went wrong");
    }
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        onClick={open}
        disabled={loading}
        className="rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {loading ? "Opening…" : "Open your document"}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
