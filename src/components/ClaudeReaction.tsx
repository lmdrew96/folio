"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Markdown } from "@/components/Markdown";
import { folioClaudeLabel } from "@/lib/identity";
import { relativeTime } from "@/lib/time";

/** Who a shared thread turn reads as: Cleo, "You" (the viewer), or another
 *  collaborator by their denormalized display name. */
function speakerLabel(
  m: { author: string; authorName?: string },
  cleoLabel: string,
  myUserId: string | null | undefined,
): string {
  if (m.author === "claude") return cleoLabel;
  if (myUserId && m.author === myUserId) return "You";
  return m.authorName ?? "Collaborator";
}

type Mode = "reaction" | "chat" | "check";

const TEXTAREA_MAX_PX = 112; // ~4 lines

export function ClaudeReaction({ documentId }: { documentId: Id<"documents"> }) {
  const label = folioClaudeLabel();
  const { userId } = useAuth();

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
    <section className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{label}</h2>
          <p className="truncate text-[11px] text-black/40 dark:text-white/40">
            your digital writing partner
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

      <ApplicationStrip
        documentId={documentId}
        busy={busy}
        checking={streaming?.mode === "check"}
        onCheck={() => void getReply("check")}
      />

      <div ref={listRef} className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
        {history.map((m) => (
          <article
            key={m.id}
            className="min-w-0 rounded-md border border-black/5 bg-white/30 p-3 dark:border-white/10 dark:bg-white/[0.03]"
          >
            <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-black/40 dark:text-white/40">
              <span className="min-w-0 truncate">
                {speakerLabel(m, label, userId)}
                {m.kind === "reaction" && m.summary ? ` · reacted to ${m.summary}` : ""}
                {m.kind === "check" ? " · application check" : ""}
              </span>
              <span className="shrink-0">{relativeTime(m.createdAt)}</span>
            </div>
            <Markdown>{m.content}</Markdown>
          </article>
        ))}

        {streaming && (
          <article className="min-w-0 rounded-md border border-black/5 bg-white/40 p-3 dark:border-white/10 dark:bg-white/5">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-black/40 dark:text-white/40">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#CF4A4D]" />
              <span className="font-medium">{label} is replying…</span>
            </div>
            {streaming.text ? (
              <Markdown>{streaming.text}</Markdown>
            ) : (
              <p className="text-sm text-black/40 dark:text-white/40">
                {streaming.mode === "reaction"
                  ? "Reading what changed…"
                  : streaming.mode === "check"
                    ? "Reading the prompt and your draft…"
                    : "Thinking…"}
              </p>
            )}
          </article>
        )}

        {error && (
          <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
            <span className="min-w-0 break-words">{error.message}</span>
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

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

/**
 * What this document is written for: an application prompt (pasted text, a
 * screenshot, or both) and its word limit. Saved on the document, so checking
 * the draft against it again after edits is one click. Cleo only reports — her
 * check never touches the document.
 */
function ApplicationStrip({
  documentId,
  busy,
  checking,
  onCheck,
}: {
  documentId: Id<"documents">;
  busy: boolean;
  checking: boolean;
  onCheck: () => void;
}) {
  const app = useQuery(api.documents.application, { documentId });
  const uploadUrl = useMutation(api.documents.applicationUploadUrl);
  const save = useMutation(api.documents.setApplication);
  const clear = useMutation(api.documents.clearApplication);

  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [limit, setLimit] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dropSaved, setDropSaved] = useState(false); // remove the saved screenshot
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Revoke the local preview URL when it's replaced or the form closes.
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  if (app === undefined) return null;

  const open = () => {
    setPrompt(app?.prompt ?? "");
    setLimit(app?.wordLimit ? String(app.wordLimit) : "");
    setImage(null);
    setPreview(null);
    setDropSaved(false);
    setProblem(null);
    setEditing(true);
  };

  const pickImage = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return setProblem("That isn't an image.");
    if (file.size > MAX_SCREENSHOT_BYTES) return setProblem("That screenshot is over 5 MB.");
    setProblem(null);
    setImage(file);
    setPreview(URL.createObjectURL(file));
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith("image/"));
    if (file) {
      e.preventDefault();
      pickImage(file);
    }
  };

  const submit = async () => {
    const wordLimit = limit.trim() ? Math.round(Number(limit.replace(/[,\s_]/g, ""))) : null;
    if (wordLimit !== null && !(Number.isFinite(wordLimit) && wordLimit >= 1)) {
      return setProblem("Enter the word limit as a whole number, or leave it blank.");
    }
    const keepsImage = !dropSaved && Boolean(app?.imageUrl);
    if (!prompt.trim() && !image && !keepsImage) {
      return setProblem("Paste the prompt's text or add a screenshot of it.");
    }
    setSaving(true);
    setProblem(null);
    try {
      let imageId: Id<"_storage"> | null | undefined = dropSaved ? null : undefined;
      if (image) {
        const res = await fetch(await uploadUrl(), {
          method: "POST",
          headers: { "Content-Type": image.type },
          body: image,
        });
        if (!res.ok) throw new Error(`Upload failed (${res.status})`);
        imageId = ((await res.json()) as { storageId: Id<"_storage"> }).storageId;
      }
      await save({ documentId, prompt, wordLimit, imageId });
      setEditing(false);
      onCheck();
    } catch (e) {
      console.error("Folio: saving the application prompt failed", e);
      setProblem(e instanceof Error ? e.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await clear({ documentId });
      setEditing(false);
    } catch (e) {
      console.error("Folio: clearing the application prompt failed", e);
      setProblem("Couldn't remove it.");
    }
  };

  const pill =
    "shrink-0 rounded-full border border-black/10 px-2.5 py-1 text-xs transition hover:bg-black/5 disabled:opacity-50 dark:border-white/15 dark:hover:bg-white/10";

  if (!editing) {
    if (!app) {
      return (
        <div className="px-4 pb-2">
          <button onClick={open} className="text-xs text-black/50 underline-offset-2 hover:underline dark:text-white/50">
            Writing this for an application? Add the prompt
          </button>
        </div>
      );
    }
    return (
      <div className="mx-4 mb-2 flex min-w-0 items-center gap-2 rounded-md border border-black/5 px-3 py-2 dark:border-white/10">
        <div className="min-w-0 flex-1 text-xs text-black/60 dark:text-white/60">
          <p className="font-medium text-foreground/80">
            Application{app.wordLimit ? ` · ${app.wordLimit.toLocaleString()}-word limit` : ""}
          </p>
          <p className="truncate">{app.prompt || "Prompt from a screenshot"}</p>
        </div>
        <button onClick={open} disabled={busy} className={pill}>
          Edit
        </button>
        <button
          onClick={onCheck}
          disabled={busy}
          className="shrink-0 rounded-full bg-foreground px-2.5 py-1 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {checking ? "Checking…" : "Check draft"}
        </button>
      </div>
    );
  }

  const shownImage = preview ?? (dropSaved ? null : (app?.imageUrl ?? null));
  return (
    <div className="mx-4 mb-2 flex min-w-0 flex-col gap-2 rounded-md border border-black/5 p-3 dark:border-white/10">
      <label className="text-xs font-medium text-foreground/80" htmlFor="folio-app-prompt">
        Application prompt
      </label>
      <textarea
        id="folio-app-prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onPaste={onPaste}
        rows={4}
        placeholder="Paste the prompt here — or paste a screenshot of it"
        className="resize-y rounded-md border border-black/10 bg-white/50 px-3 py-2 text-sm outline-none focus:border-black/20 dark:border-white/10 dark:bg-white/5 dark:focus:border-white/20"
      />
      {shownImage ? (
        <div className="flex items-start gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local blob or signed storage URL */}
          <img src={shownImage} alt="Screenshot of the prompt" className="max-h-32 max-w-[70%] rounded border border-black/10 object-contain dark:border-white/10" />
          <button
            onClick={() => {
              setImage(null);
              setPreview(null);
              if (app?.imageUrl) setDropSaved(true);
            }}
            className={pill}
          >
            Remove screenshot
          </button>
        </div>
      ) : (
        <div>
          <button onClick={() => fileRef.current?.click()} className={pill}>
            Add a screenshot
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              pickImage(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
      )}
      <label className="flex items-center gap-2 text-xs text-foreground/80">
        Word limit
        <input
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          inputMode="numeric"
          placeholder="e.g. 650"
          className="w-24 rounded-md border border-black/10 bg-white/50 px-2 py-1 text-sm outline-none focus:border-black/20 dark:border-white/10 dark:bg-white/5 dark:focus:border-white/20"
        />
      </label>
      {problem && (
        <p className="text-xs text-red-700 dark:text-red-300" role="alert">
          {problem}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={() => void submit()}
          disabled={saving || busy}
          className="rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save and check"}
        </button>
        <button onClick={() => setEditing(false)} disabled={saving} className={pill}>
          Cancel
        </button>
        {app && (
          <button onClick={() => void remove()} disabled={saving} className={`${pill} ml-auto`}>
            Remove prompt
          </button>
        )}
      </div>
    </div>
  );
}
