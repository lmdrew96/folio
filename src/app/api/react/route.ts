import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import Anthropic from "@anthropic-ai/sdk";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Deliberately plain — P5 proves the react mechanism. Identity/continuity is the
// separate v1 patch (do not thread prefs/Tangle/sibling-identity here).
const SYSTEM =
  "You are reacting to changes in Nae's writing. You see only what changed " +
  "since you last looked, plus light surrounding context — not the whole " +
  "document. React; don't rewrite. Be specific about what actually moved, keep " +
  "it short, and skip generic praise.";

type ReactionItem = {
  blockId: string;
  type: string;
  text: string;
  prevText: string | null;
  nextText: string | null;
};
type DeletedItem = { blockId: string; type: string; text: string };
type ReactionPayload = {
  hasChanges: boolean;
  firstLook: boolean;
  added: ReactionItem[];
  edited: ReactionItem[];
  deleted: DeletedItem[];
};

function buildPrompt(p: ReactionPayload): string {
  const q = (s: string | null) => JSON.stringify(s ?? "");
  const lines: string[] = [];

  if (p.firstLook) {
    lines.push(
      "This is the first time you're looking at this document. Here is its current content, block by block.\n",
    );
    lines.push("## Document");
    for (const it of p.added) lines.push(`- [${it.type}] ${q(it.text)}`);
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
      lines.push(`- [${it.type}] ${q(it.text)}`);
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
    for (const it of p.deleted) lines.push(`- [${it.type}] ${q(it.text)}`);
    lines.push("");
  }
  lines.push(
    "React to these specific changes — be concrete about what moved. Respond as a thoughtful collaborator noticing what changed.",
  );
  return lines.join("\n");
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

  const payload: ReactionPayload = await convex.query(api.diff.reactionPayload, {
    documentId: docId,
  });

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
    system: SYSTEM,
    messages: [{ role: "user", content: buildPrompt(payload) }],
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of llm) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
        // Advance Claude's watermark only after a successful reaction.
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
