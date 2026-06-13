import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import Anthropic from "@anthropic-ai/sdk";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { composeSystemPrompt } from "@/lib/identity";
import { fetchNaeContext, fetchFolioCanon } from "@/lib/edges";
import { relativeTime } from "@/lib/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// v1 continuity layer: Cleo arrives with her identity + the LIVE edges her
// siblings read (Nae's pctx context + her own Tangle continuity), block
// attribution, and her memory of this document's prior reactions — assembled
// fresh per request. (P5 was deliberately hollow; v0 shipped, so it grew up.)

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
type PriorReaction = { content: string; summary: string; createdAt: number };

/** The continuity edge: what this sibling said on previous visits to the doc. */
function priorSection(prior: PriorReaction[]): string[] {
  if (!prior.length) return [];
  const lines = [
    "## What you noticed on earlier visits to this document",
    "(Oldest first. This is your own memory — build on it; don't just repeat it.)",
    "",
  ];
  // Oldest → newest reads like a timeline of your engagement with the writing.
  for (const r of [...prior].reverse()) {
    lines.push(`### ${relativeTime(r.createdAt)} — you reacted to ${r.summary}`);
    lines.push(r.content.trim());
    lines.push("");
  }
  return lines;
}

function buildPrompt(p: ReactionPayload, prior: PriorReaction[]): string {
  const q = (s: string | null) => JSON.stringify(s ?? "");
  const lines: string[] = [...priorSection(prior)];

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
    prior.length
      ? "React to these specific changes — be concrete about what moved, and connect it to what you noticed before where it's relevant."
      : "React to these specific changes — be concrete about what moved. Respond as a thoughtful collaborator noticing what changed.",
  );
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

export async function POST(req: Request) {
  const { userId, getToken } = await auth();
  if (!userId) return new Response("Unauthorized", { status: 401 });

  let documentId: string | undefined;
  try {
    documentId = ((await req.json()) as { documentId?: string }).documentId;
  } catch {
    // fall through to the missing-id check
  }
  if (!documentId) return new Response("Missing documentId", { status: 400 });

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

  // Fetch everything Cleo arrives with in parallel: the diff, her prior takes on
  // this doc, and her live edges (Nae's pctx context + her own Tangle continuity).
  // The edge fetches fail soft — composeSystemPrompt falls back to baked text.
  const [payload, prior, naeContext, folioCanon] = await Promise.all([
    convex.query(api.diff.reactionPayload, { documentId: docId }),
    convex.query(api.reactions.recent, {
      documentId: docId,
      limit: 3,
    }) as Promise<PriorReaction[]>,
    fetchNaeContext(),
    fetchFolioCanon(),
  ]);

  const plain = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };
  if (!payload.hasChanges) {
    return new Response("Nothing has changed since Claude last looked.", {
      headers: plain,
    });
  }

  const anthropic = new Anthropic();
  const llm = anthropic.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 1500,
    system: composeSystemPrompt({ naeContext, folioCanon }),
    messages: [{ role: "user", content: buildPrompt(payload, prior) }],
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
        // Persist this reaction (the sibling's memory) and advance Claude's
        // watermark — both only after a successful stream.
        await convex.mutation(api.reactions.record, {
          documentId: docId,
          content: full,
          summary: summarize(payload),
        });
        await convex.mutation(api.diff.markVisited, {
          documentId: docId,
          userId: "claude",
        });
      } catch (err) {
        console.error("Folio: reaction stream failed", err);
        controller.enqueue(
          encoder.encode("\n\n_(Claude hit an error generating this reaction.)_"),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: plain });
}
