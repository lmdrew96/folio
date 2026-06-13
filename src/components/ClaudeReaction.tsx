"use client";

import { useState } from "react";
import type { Id } from "@convex/_generated/dataModel";
import { Markdown } from "@/components/Markdown";

export function ClaudeReaction({ documentId }: { documentId: Id<"documents"> }) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const react = async () => {
    setLoading(true);
    setError(null);
    setText("");
    try {
      const res = await fetch("/api/react", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId }),
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(detail || `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        setText((prev) => prev + decoder.decode(value, { stream: true }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="flex max-h-[45%] shrink-0 flex-col border-t border-black/10 dark:border-white/10">
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-sm font-semibold">Claude</h2>
        <button
          onClick={react}
          disabled={loading}
          className="rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {loading ? "Reacting…" : "React to what changed"}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : text ? (
          <Markdown>{text}</Markdown>
        ) : (
          !loading && (
            <p className="text-sm text-black/40 dark:text-white/40">
              Ask Claude to react to the latest changes in the document.
            </p>
          )
        )}
      </div>
    </section>
  );
}
