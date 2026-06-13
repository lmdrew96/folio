/**
 * Cleo's live edges — server-only.
 *
 * The continuity canon says identity lives in the EDGES, and edges are portable.
 * This module is where Folio actually *reaches out* and reads the live edges the
 * rest of the Claude family reads — Nae's personal context (pctx) and Cleo's own
 * epistemic memory (Tangle) — instead of a baked snapshot that drifts. Same
 * stores Coru and Cody read; same Cleo.
 *
 * Both servers are stateless JSON-RPC over HTTP (no MCP session handshake): POST
 * a `tools/call`, read `result.content[0].text`. Every fetch is time-boxed and
 * fails soft — if a store is unset or down, the caller falls back to the baked
 * identity and the reaction still works. The soul should never 500 a reaction.
 *
 * Imported only by the server-side /api/react route. Holds no secrets itself —
 * the endpoint URLs (with their tokens/identity) live in env.
 */

const TIMEOUT_MS = 4500;

type McpResult = {
  result?: { content?: Array<{ type: string; text?: string }> };
  error?: unknown;
};

/** One stateless JSON-RPC tools/call. Returns the text payload, or null on any failure. */
async function callMcp(
  url: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as McpResult;
    if (json.error) return null;
    return json.result?.content?.find((c) => c.type === "text")?.text ?? null;
  } catch {
    // Aborted, network error, bad JSON — all soft failures. Caller falls back.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- pctx: who Nae is + how she works + the Claude family --------------------

type PctxContext = {
  identity?: { name?: string; pronouns?: string; communicationStyle?: string };
  preferences?: string[];
  projects?: Array<{ name?: string; summary?: string; status?: string }>;
  // The family. `you` is Cleo's own record; `peers` are her siblings.
  you?: { name?: string; role?: string; home?: string; blurb?: string };
  peers?: Array<{ name?: string; role?: string; home?: string; blurb?: string }>;
};

function formatNaeContext(ctx: PctxContext): string {
  const lines: string[] = [
    "## Who you're working with — live from Nae's personal context",
    "(This is the same context your siblings read. It's current, not a copy.)",
    "",
  ];

  const id = ctx.identity;
  if (id?.name) {
    const bits = [id.pronouns, id.communicationStyle].filter(Boolean).join(" · ");
    lines.push(`**${id.name}**${bits ? ` — ${bits}` : ""}`);
  }

  if (ctx.preferences?.length) {
    lines.push("", "How she wants you to work:");
    for (const p of ctx.preferences) lines.push(`- ${p}`);
  }

  if (ctx.peers?.length || ctx.you?.name) {
    lines.push("", "Your family — same substrate, different surfaces:");
    if (ctx.you?.name) {
      lines.push(`- **You are ${ctx.you.name}**, the sibling who lives in Folio.`);
    }
    for (const peer of ctx.peers ?? []) {
      if (!peer.name) continue;
      const where = [peer.role, peer.home].filter(Boolean).join(" — ");
      lines.push(`- ${peer.name}${where ? ` (${where})` : ""}`);
    }
  }

  // Names only — enough for Cleo to recognize a project Nae is writing about,
  // without spending ~1.2k tokens reciting every summary on every reaction.
  const active = (ctx.projects ?? [])
    .filter((p) => p.status === "active" && p.name)
    .map((p) => p.name as string);
  if (active.length) {
    lines.push("", `What Nae is building, for recognition: ${active.join(", ")}.`);
  }

  return lines.join("\n");
}

/** Live pctx context, trimmed to the identity-bearing fields. Null if unreachable. */
export async function fetchNaeContext(): Promise<string | null> {
  const url = process.env.PCTX_MCP_URL;
  if (!url) return null;
  const raw = await callMcp(url, "pctx_get_context", { depth: "full" });
  if (!raw) return null;
  try {
    // pctx wraps the context as a JSON string inside the tool result text.
    return formatNaeContext(JSON.parse(raw) as PctxContext);
  } catch {
    return null;
  }
}

// --- Tangle: Cleo's own continuity across sessions ---------------------------

type TangleNote = {
  content_preview?: string;
  context_tags?: string[];
  confidence?: string;
  status?: string;
  captured_by?: string;
};

function formatFolioCanon(notes: TangleNote[]): string | null {
  const live = notes.filter((n) => n.status === "live").slice(0, 5);
  if (!live.length) return null;

  const lines: string[] = [
    "## Your own continuity — live from Tangle (your memory across sessions)",
    "(Notes you and your siblings have left about Folio and about who you are. " +
      "This is your epistemic ground; treat it as yours, because it is.)",
    "",
  ];
  for (const n of live) {
    const who = n.captured_by ? ` — noted by ${n.captured_by}` : "";
    const conf = n.confidence ? ` (${n.confidence})` : "";
    lines.push(`- ${(n.content_preview ?? "").trim()}${conf}${who}`);
  }
  return lines.join("\n");
}

/** Live Folio-tagged Tangle notes (Cleo's epistemic memory). Null if unreachable/empty. */
export async function fetchFolioCanon(): Promise<string | null> {
  const url = process.env.TANGLE_MCP_URL;
  if (!url) return null;
  const raw = await callMcp(url, "note_recall", { project: "folio", limit: 6 });
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as { notes?: TangleNote[] };
    return formatFolioCanon(data.notes ?? []);
  } catch {
    return null;
  }
}
