"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Markdown } from "@/components/Markdown";
import { folioClaudeLabel } from "@/lib/identity";
import { relativeTime } from "@/lib/time";

export function ClaudeReaction({ documentId }: { documentId: Id<"documents"> }) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The continuity edge made visible: the sibling's own past reactions to this
  // document, newest first. Reactive — a freshly-streamed reaction lands here the
  // moment the route persists it.
  const recent = useQuery(api.reactions.recent, { documentId }) ?? [];
  // The reaction currently on screen is persisted as the newest row; show it once
  // (as the live card) by filtering it out of the history list below.
  const history = text.trim() ? recent.filter((r) => r.content !== text) : recent;
  const label = folioClaudeLabel();

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

  const empty = !error && !text && history.length === 0 && !loading;

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{label}</h2>
          <p className="truncate text-[11px] text-black/40 dark:text-white/40">
            your Folio sibling · remembers what changed
          </p>
        </div>
        <button
          onClick={react}
          disabled={loading}
          className="shrink-0 rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {loading ? "Reacting…" : "React to what changed"}
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
        {error && <p className="text-sm text-red-600">{error}</p>}

        {/* The reaction streaming in right now (or the one just finished). */}
        {(loading || text) && (
          <article className="rounded-md border border-black/5 bg-white/40 p-3 dark:border-white/10 dark:bg-white/5">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-black/40 dark:text-white/40">
              {loading && (
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#849440]" />
              )}
              <span className="font-medium">{loading ? "reacting now" : "just now"}</span>
            </div>
            {text ? (
              <Markdown>{text}</Markdown>
            ) : (
              <p className="text-sm text-black/40 dark:text-white/40">Reading what changed…</p>
            )}
          </article>
        )}

        {/* What the sibling noticed on earlier visits. */}
        {history.map((r) => (
          <article
            key={r.id}
            className="rounded-md border border-black/5 bg-white/30 p-3 dark:border-white/10 dark:bg-white/[0.03]"
          >
            <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-black/40 dark:text-white/40">
              <span className="truncate">reacted to {r.summary}</span>
              <span className="shrink-0">{relativeTime(r.createdAt)}</span>
            </div>
            <Markdown>{r.content}</Markdown>
          </article>
        ))}

        {empty && (
          <p className="text-sm text-black/40 dark:text-white/40">
            Ask {label} to react to the latest changes. It remembers its past reactions to
            this document, so each one builds on the last.
          </p>
        )}
      </div>
    </section>
  );
}
