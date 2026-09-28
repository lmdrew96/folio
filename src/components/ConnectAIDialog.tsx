"use client";

import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { relativeTime } from "@/lib/time";

/** The MCP door lives on the deployment's HTTP-actions host (.convex.site),
 *  not the client API host (.convex.cloud). Trailing slashes trimmed — a stray
 *  one on the env var once broke the whole app with a `//api` path. */
const MCP_BASE = (process.env.NEXT_PUBLIC_CONVEX_URL ?? "")
  .replace(/\/+$/, "")
  .replace(/\.convex\.cloud$/, ".convex.site");

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("copied");
        } catch {
          // Clipboard blocked (permissions, insecure context) — the text is
          // still selectable right beside the button.
          setState("failed");
        }
        setTimeout(() => setState("idle"), 1800);
      }}
      className="shrink-0 rounded-md bg-black/5 px-2.5 py-1 text-xs font-medium text-foreground transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Select & copy" : label}
    </button>
  );
}

function CodeLine({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap rounded-md bg-black/5 px-2 py-1.5 font-mono text-[11px] text-foreground dark:bg-white/10">
        {text}
      </code>
      <CopyButton text={text} />
    </div>
  );
}

function KeyRow({
  k,
}: {
  k: { _id: Id<"apiKeys">; label: string; last4: string; createdAt: number; lastUsedAt?: number };
}) {
  const revoke = useMutation(api.apiKeys.revoke);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm text-foreground">
          {k.label} <span className="font-mono text-xs text-foreground/40">…{k.last4}</span>
        </p>
        <p className="text-xs text-foreground/50">
          made {relativeTime(k.createdAt)} ·{" "}
          {k.lastUsedAt ? `last used ${relativeTime(k.lastUsedAt)}` : "never used"}
        </p>
      </div>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await revoke({ keyId: k._id });
              } catch (e) {
                console.error("Folio: revoke failed", e);
                setBusy(false);
                setConfirming(false);
              }
            }}
            className="rounded-full px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            {busy ? "Revoking…" : "Revoke"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(false)}
            className="rounded-full px-2.5 py-1 text-xs text-foreground/60 hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label={`Revoke ${k.label}`}
          className="shrink-0 rounded-full px-2.5 py-1 text-xs text-foreground/60 transition hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
        >
          Revoke
        </button>
      )}
    </li>
  );
}

/**
 * Personal MCP keys: give Claude, ChatGPT or any MCP-capable assistant
 * read-only access to your documents. One key per AI — its name doubles as
 * the AI's identity for "what changed since you last looked".
 */
export function ConnectAIDialog({ onClose }: { onClose: () => void }) {
  const keys = useQuery(api.apiKeys.list);
  const create = useAction(api.apiKeys.create);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The one and only time the plaintext exists client-side.
  const [fresh, setFresh] = useState<{ label: string; key: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = label.trim();
    if (!name) {
      setError("Name it after the AI that will use it — e.g. Claude, ChatGPT.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { key } = await create({ label: name });
      setFresh({ label: name, key });
      setLabel("");
    } catch (err) {
      console.error("Folio: key creation failed", err);
      setError(err instanceof Error ? err.message.replace(/^.*Uncaught Error: /, "") : "Couldn't make a key — try again.");
    } finally {
      setBusy(false);
    }
  };

  const url = fresh ? `${MCP_BASE}/mcp/${fresh.key}` : "";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/30"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Connect an AI"
        className="folio-card relative flex max-h-[90dvh] w-full max-w-md flex-col gap-4 overflow-y-auto p-5"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-lg text-foreground">Connect an AI</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/60 transition hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-foreground/70">
          Let Claude, ChatGPT or any assistant that speaks MCP read your documents —
          yours and ones shared with you. Read-only: it can see what changed since it
          last looked, but it can never edit.
        </p>

        {fresh ? (
          <div className="flex flex-col gap-3 rounded-lg border border-foreground/15 p-3">
            <p className="text-sm font-medium text-foreground">
              {fresh.label}&rsquo;s link — copy it now. It won&rsquo;t be shown again.
            </p>
            <CodeLine text={url} />
            <div className="flex flex-col gap-2 text-xs text-foreground/70">
              <p>
                <span className="font-medium text-foreground">Claude (claude.ai / desktop):</span>{" "}
                Settings → Connectors → Add custom connector, and paste the link.
              </p>
              <div className="flex flex-col gap-1">
                <p>
                  <span className="font-medium text-foreground">Claude Code:</span>
                </p>
                <CodeLine text={`claude mcp add --transport http folio ${url}`} />
              </div>
              <p>
                <span className="font-medium text-foreground">Anything else:</span> add it as
                an MCP server using Streamable HTTP and paste the link. Clients that can send
                headers may instead use <code className="font-mono">{MCP_BASE}/mcp</code> with{" "}
                <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>.
              </p>
              <p className="text-foreground/50">
                The link contains the key — treat it like a password. Revoke it below if it
                ever leaks.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setFresh(null)}
              className="self-end rounded-md bg-black/5 px-3 py-1 text-xs font-medium text-foreground transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="flex flex-col gap-1.5">
            <label htmlFor="folio-key-label" className="text-xs text-foreground/50">
              Which AI is this for?
            </label>
            <div className="flex items-center gap-2">
              <input
                id="folio-key-label"
                value={label}
                maxLength={50}
                onChange={(e) => {
                  setLabel(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="e.g. Claude, ChatGPT"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "folio-key-error" : undefined}
                className="min-w-0 flex-1 rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-3.5 py-1.5 text-sm text-foreground outline-none transition placeholder:text-foreground/40 focus:ring-2 focus:ring-[var(--folio-attr-sibling)]"
              />
              <button
                type="submit"
                disabled={busy}
                className="shrink-0 rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Making…" : "Make a link"}
              </button>
            </div>
            {error && (
              <p id="folio-key-error" role="alert" className="text-xs text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
          </form>
        )}

        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide text-foreground/45">
            Connected AIs
          </h3>
          {keys === undefined ? (
            <p className="py-2 text-sm text-foreground/50">Loading…</p>
          ) : keys.length === 0 ? (
            <p className="py-2 text-sm text-foreground/50">None yet.</p>
          ) : (
            <ul className="divide-y divide-foreground/10">
              {keys.map((k) => (
                <KeyRow key={k._id} k={k} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
