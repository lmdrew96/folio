"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Markdown } from "@/components/Markdown";
import { folioClaudeLabel } from "@/lib/identity";
import { relativeTime } from "@/lib/time";

type Mode = "reaction" | "chat";

const TEXTAREA_MAX_PX = 112; // ~4 lines

export function ClaudeReaction({ documentId }: { documentId: Id<"documents"> }) {
  const label = folioClaudeLabel();

  // Reactive — a freshly-sent message or streamed reply lands here the moment
  // it's persisted, for either side of the conversation.
  const history = useQuery(api.messages.history, { documentId }) ?? [];
  const sendMessage = useMutation(api.messages.send);

  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState<{ mode: Mode; text: string } | null>(null);
  const [error, setError] = useState<{ mode: Mode; message: string } | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const busy = streaming !== null;

  // Keep the latest turn in view as history grows or a reply streams in.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [history.length, streaming?.text]);

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_PX)}px`;
  };

  /** Stream Cleo's reply for the given mode. Assumes any preceding turn
   *  (Nae's chat message, or nothing for a reaction) is already persisted. */
  const getReply = async (mode: Mode) => {
    setError(null);
    setStreaming({ mode, text: "" });
    try {
      const res = await fetch("/api/cleo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, mode }),
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(detail || `Request failed (${res.status})`);
      }
      if (res.headers.get("X-Cleo-Notice") === "no-changes") {
        setStreaming(null);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setStreaming((prev) => (prev ? { ...prev, text: prev.text + chunk } : prev));
      }
    } catch (e) {
      setError({
        mode,
        message: e instanceof Error ? e.message : "Something went wrong",
      });
    } finally {
      setStreaming(null);
    }
  };

  const react = () => {
    if (busy) return;
    void getReply("reaction");
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    try {
      await sendMessage({ documentId, content: text });
    } catch (e) {
      // The message never made it in — give the draft back rather than
      // silently dropping what she typed.
      setDraft(text);
      setError({
        mode: "chat",
        message: e instanceof Error ? e.message : "Couldn't send that.",
      });
      return;
    }
    // Nae's turn is already visible via the reactive query above; now get
    // Cleo's reply. If this half fails, her message stays put and Retry
    // re-fires just this call.
    await getReply("chat");
  };

  const retry = () => {
    if (!error) return;
    const mode = error.mode;
    setError(null);
    void getReply(mode);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const empty = !busy && !error && history.length === 0;

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{label}</h2>
          <p className="truncate text-[11px] text-black/40 dark:text-white/40">
            your Folio sibling · remembers this conversation
          </p>
        </div>
        <button
          onClick={react}
          disabled={busy}
          className="shrink-0 rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {streaming?.mode === "reaction" ? "Reacting…" : "React to what changed"}
        </button>
      </div>

      <div ref={listRef} className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
        {history.map((m) => (
          <article
            key={m.id}
            className="rounded-md border border-black/5 bg-white/30 p-3 dark:border-white/10 dark:bg-white/[0.03]"
          >
            <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-black/40 dark:text-white/40">
              <span className="truncate">
                {m.author === "nae" ? "Nae" : label}
                {m.kind === "reaction" && m.summary ? ` · reacted to ${m.summary}` : ""}
              </span>
              <span className="shrink-0">{relativeTime(m.createdAt)}</span>
            </div>
            <Markdown>{m.content}</Markdown>
          </article>
        ))}

        {streaming && (
          <article className="rounded-md border border-black/5 bg-white/40 p-3 dark:border-white/10 dark:bg-white/5">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-black/40 dark:text-white/40">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#849440]" />
              <span className="font-medium">{label} is replying…</span>
            </div>
            {streaming.text ? (
              <Markdown>{streaming.text}</Markdown>
            ) : (
              <p className="text-sm text-black/40 dark:text-white/40">
                {streaming.mode === "reaction" ? "Reading what changed…" : "Thinking…"}
              </p>
            )}
          </article>
        )}

        {error && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
            <span>{error.message}</span>
            <button
              onClick={retry}
              className="shrink-0 rounded-full border border-red-300 px-2.5 py-1 text-xs font-medium hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-900/40"
            >
              Retry
            </button>
          </div>
        )}

        {empty && (
          <p className="text-sm text-black/40 dark:text-white/40">
            Ask {label} what she thinks, or have her react to the latest changes. She remembers
            this conversation, turn by turn.
          </p>
        )}
      </div>

      <div className="flex items-end gap-2 border-t border-black/5 p-3 dark:border-white/10">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            autoGrow(e.target);
          }}
          onKeyDown={handleKeyDown}
          disabled={busy}
          rows={1}
          aria-label={`Ask ${label} something`}
          placeholder={`Ask ${label} something…`}
          className="min-h-9 flex-1 resize-none rounded-md border border-black/10 bg-white/50 px-3 py-2 text-sm outline-none focus:border-black/20 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:focus:border-white/20"
          style={{ maxHeight: TEXTAREA_MAX_PX }}
        />
        <button
          onClick={() => void send()}
          disabled={busy || !draft.trim()}
          className="shrink-0 rounded-full bg-foreground px-3 py-2 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </section>
  );
}
