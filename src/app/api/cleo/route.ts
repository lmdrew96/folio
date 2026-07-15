import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import Anthropic from "@anthropic-ai/sdk";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { composeSystemPrompt } from "@/lib/identity";
import { fetchNaeContext, fetchFolioCanon } from "@/lib/edges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// v1 continuity layer: Cleo arrives with her identity + the LIVE edges her
// siblings read (Nae's pctx context + her own Tangle continuity), block
// attribution, and the real conversation history for this document — assembled
// fresh per request. Two modes share this route: "reaction" (the zero-effort
// "React to what changed" button) and "chat" (Nae talking to her directly).

type ReactionItem = {
  blockId: string;
  type: string;
  author: string;
  text: string;
  prevText: string | null;
  nextText: string | null;
};
type DeletedItem = {
  blockId: string;
  type: string;
  author: string;
  text: string;
};
type ReactionPayload = {
  hasChanges: boolean;
  firstLook: boolean;
  added: ReactionItem[];
  edited: ReactionItem[];
  deleted: DeletedItem[];
};
type MessageRow = { author: "nae" | "claude"; content: string };

/** The ephemeral instruction turn for "reaction" mode — never persisted as a row. */
function buildPrompt(p: ReactionPayload): string {
  const q = (s: string | null) => JSON.stringify(s ?? "");
  const lines: string[] = [];

  if (p.firstLook) {
    lines.push(
      "This is the first time you're looking at this document. Here is its current content, block by block.\n",
    );
    lines.push("## Document");
    for (const it of p.added) lines.push(`- [${it.type}, by ${it.author}] ${q(it.text)}`);
    lines.push("");
    lines.push(
      "React to the document as it stands — what stands out, what's interesting. Be specific and brief.",
    );
    return lines.join("\n");
  }

  lines.push("Here is what changed in Nae's document since you last looked.\n");
  const section = (title: string, items: ReactionItem[]) => {
    if (!items.length) return;
    lines.push(`## ${title}`);
    for (const it of items) {
      lines.push(`- [${it.type}, by ${it.author}] ${q(it.text)}`);
      if (it.prevText || it.nextText) {
        lines.push(
          `    surrounding context — before: ${q(it.prevText)}; after: ${q(it.nextText)}`,
        );
      }
    }
    lines.push("");
  };
  section("Added", p.added);
  section("Edited", p.edited);
  if (p.deleted.length) {
    lines.push("## Deleted");
    for (const it of p.deleted) lines.push(`- [${it.type}, by ${it.author}] ${q(it.text)}`);
    lines.push("");
  }
  lines.push(
    "React to these specific changes — be concrete about what moved, and connect it to what you noticed earlier in this conversation where it's relevant.",
  );
  return lines.join("\n");
}

/**
 * Passive background context for "chat" mode — folded into the system prompt,
 * not a turn. Without this, Cleo would be blind to the actual document during
 * free-form chat and could only discuss what's already been said in
 * conversation. Returns null when there's nothing to add (payload has no
 * changes since her watermark).
 */
function buildDiffReference(p: ReactionPayload): string | null {
  if (!p.hasChanges) return null;
  const q = (s: string | null) => JSON.stringify(s ?? "");
  const lines: string[] = [
    p.firstLook
      ? "## For reference — you haven't looked at this document yet. Here's its current content, block by block."
      : "## For reference — what's changed in the document since you last looked",
    "(Nae isn't asking you to react to this right now — it's just context in case it helps with what she's asking.)",
    "",
  ];

  if (p.firstLook) {
    for (const it of p.added) lines.push(`- [${it.type}, by ${it.author}] ${q(it.text)}`);
    return lines.join("\n");
  }

  const section = (title: string, items: ReactionItem[]) => {
    if (!items.length) return;
    lines.push(`### ${title}`);
    for (const it of items) lines.push(`- [${it.type}, by ${it.author}] ${q(it.text)}`);
    lines.push("");
  };
  section("Added", p.added);
  section("Edited", p.edited);
  if (p.deleted.length) {
    lines.push("### Deleted");
    for (const it of p.deleted) lines.push(`- [${it.type}, by ${it.author}] ${q(it.text)}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Terse note of what a reaction engaged with, stored alongside it for continuity. */
function summarize(p: ReactionPayload): string {
  if (p.firstLook) return "the document for the first time";
  const parts: string[] = [];
  if (p.added.length) parts.push(`${p.added.length} added`);
  if (p.edited.length) parts.push(`${p.edited.length} edited`);
  if (p.deleted.length) parts.push(`${p.deleted.length} deleted`);
  return parts.join(" · ") || "no changes";
}

/**
 * Real conversation history → Anthropic turns. Consecutive same-author rows
 * are merged into one turn (defensive — keeps the array valid regardless of
 * whether the API would otherwise reject/mis-handle back-to-back same-role
 * turns, e.g. an unanswered chat message followed by a "react to changes"
 * click).
 */
function toAnthropicMessages(rows: MessageRow[]): Anthropic.MessageParam[] {
  const merged: Anthropic.MessageParam[] = [];
  for (const m of rows) {
    const role: "user" | "assistant" = m.author === "nae" ? "user" : "assistant";
    const last = merged[merged.length - 1];
    if (last && last.role === role && typeof last.content === "string") {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      merged.push({ role, content: m.content });
    }
  }
  return merged;
}

export async function POST(req: Request) {
  const { userId, getToken } = await auth();
  if (!userId) return new Response("Unauthorized", { status: 401 });

  let documentId: string | undefined;
  let mode: "reaction" | "chat" | undefined;
  try {
    const body = (await req.json()) as { documentId?: string; mode?: string };
    documentId = body.documentId;
    if (body.mode === "reaction" || body.mode === "chat") mode = body.mode;
  } catch {
    // fall through to the missing-field checks
  }
  if (!documentId) return new Response("Missing documentId", { status: 400 });
  if (!mode) return new Response('Missing mode ("reaction" | "chat")', { status: 400 });

  const token = await getToken({ template: "convex" });
  if (!token) return new Response("Missing Convex token", { status: 401 });

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) return new Response("Server misconfigured", { status: 500 });
  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response("ANTHROPIC_API_KEY is not set on the server.", {
      status: 500,
    });
  }

  const convex = new ConvexHttpClient(convexUrl);
  convex.setAuth(token);
  const docId = documentId as Id<"documents">;

  // Fetch everything Cleo arrives with in parallel: the diff, the real
  // conversation history, and her live edges (Nae's pctx context + her own
  // Tangle continuity). The edge fetches fail soft — composeSystemPrompt falls
  // back to baked text.
  const [payload, history, naeContext, folioCanon] = await Promise.all([
    convex.query(api.diff.reactionPayload, { documentId: docId }),
    convex.query(api.messages.history, { documentId: docId, limit: 40 }) as Promise<
      MessageRow[]
    >,
    fetchNaeContext(),
    fetchFolioCanon(),
  ]);

  const plain = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };

  if (mode === "reaction" && !payload.hasChanges) {
    return new Response("Nothing has changed since Claude last looked.", {
      headers: { ...plain, "X-Cleo-Notice": "no-changes" },
    });
  }
  if (mode === "chat" && history.length === 0) {
    return new Response("Missing conversation turn", { status: 400 });
  }

  const systemBase = composeSystemPrompt({ naeContext, folioCanon });
  const ambient = mode === "chat" ? buildDiffReference(payload) : null;
  const system = ambient ? `${systemBase}\n\n${ambient}` : systemBase;

  const anthropicMessages =
    mode === "reaction"
      ? toAnthropicMessages([...history, { author: "nae", content: buildPrompt(payload) }])
      : toAnthropicMessages(history);

  const anthropic = new Anthropic();
  const llm = anthropic.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system,
    messages: anthropicMessages,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = "";
      try {
        for await (const event of llm) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            full += event.delta.text;
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
        // Persist the reply and, for a reaction, advance Claude's watermark —
        // both only after a successful stream.
        await convex.mutation(api.messages.recordReply, {
          documentId: docId,
          content: full,
          kind: mode,
          summary: mode === "reaction" ? summarize(payload) : undefined,
        });
        if (mode === "reaction") {
          await convex.mutation(api.diff.markVisited, {
            documentId: docId,
            userId: "claude",
          });
        }
      } catch (err) {
        console.error("Folio: Cleo stream failed", err);
        controller.enqueue(
          encoder.encode("\n\n_(Claude hit an error generating this reply.)_"),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: plain });
}
