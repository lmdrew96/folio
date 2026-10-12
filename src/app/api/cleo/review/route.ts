import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import Anthropic from "@anthropic-ai/sdk";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { SONNET_MODEL } from "@/lib/ai";
import { composeSystemPrompt } from "@/lib/identity";
import { fetchNaeContext, fetchFolioCanon } from "@/lib/edges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Course review sheet: Cleo reads 1–10 of Nae's notes and writes a study sheet
// as markdown. The sheet becomes a new document of Cleo's (the client parses
// it into blocks and calls documents.createReviewSheet); her notes are only
// read, never written.

const MAX_SOURCES = 10;

type Source = { id: string; title: string; createdAt: number; markdown: string };

/** "Sep 9" in the writer's own timezone — the server's is UTC. */
function dayLabel(ms: number, timeZone: string): string {
  try {
    return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
  } catch {
    return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }
}

function buildRequest(sources: Source[], course: string, timeZone: string): string {
  const notes = sources.map((s) =>
    [
      `<note title=${JSON.stringify(s.title || "Untitled")} date="${dayLabel(s.createdAt, timeZone)}" link="/doc/${s.id}">`,
      s.markdown || "(empty)",
      "</note>",
    ].join("\n"),
  );
  return [
    `Nae wants a review sheet to study from${course ? ` for ${course}` : ""}, built from the class notes below. This one is a new document of your own: you're writing it for her, not editing her notes.`,
    "",
    ...notes,
    "",
    "Write the sheet in markdown with exactly these sections:",
    "## Key concepts — the ideas the notes keep coming back to, a line or two each.",
    "## Definitions — terms the notes define or lean on, as a bulleted list: **term** — definition.",
    "## Likely exam questions — a numbered list of questions these notes would prepare her for.",
    "",
    "After every concept, definition and question, point back to where it came from as a link built from that note's title, date and link attribute, e.g. ([Week 3 notes · Sep 9](/doc/abc123)). Cite more than one note when it spans several.",
    "Stick to what the notes contain; where they're thin on something, say so briefly instead of filling it in from outside knowledge.",
    "Reply with the sheet only: no title line, no preamble or sign-off.",
  ].join("\n");
}

export async function POST(req: Request) {
  const { userId, getToken } = await auth();
  if (!userId) return new Response("Unauthorized", { status: 401 });

  let documentIds: string[] = [];
  let course = "";
  let timeZone = "UTC";
  try {
    const body = (await req.json()) as { documentIds?: unknown; course?: unknown; timeZone?: unknown };
    if (Array.isArray(body.documentIds)) documentIds = body.documentIds.filter((d): d is string => typeof d === "string");
    if (typeof body.course === "string") course = body.course.trim();
    if (typeof body.timeZone === "string") timeZone = body.timeZone;
  } catch {
    // fall through to the checks below
  }
  if (documentIds.length === 0) return new Response("Pick at least one document.", { status: 400 });
  if (documentIds.length > MAX_SOURCES) {
    return new Response(`Pick up to ${MAX_SOURCES} documents.`, { status: 400 });
  }

  const token = await getToken({ template: "convex" });
  if (!token) return new Response("Missing Convex token", { status: 401 });
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) return new Response("Server misconfigured", { status: 500 });
  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response("ANTHROPIC_API_KEY is not set on the server.", { status: 500 });
  }

  const convex = new ConvexHttpClient(convexUrl);
  convex.setAuth(token);

  const [sources, naeContext, folioCanon] = await Promise.all([
    convex.query(api.documents.reviewSources, {
      documentIds: documentIds as Id<"documents">[],
    }) as Promise<Source[]>,
    fetchNaeContext(),
    fetchFolioCanon(),
  ]);
  if (sources.length === 0) return new Response("Those documents couldn't be opened.", { status: 404 });
  if (sources.every((s) => !s.markdown.trim())) {
    return new Response("Those documents are empty, so there's nothing to review yet.", { status: 400 });
  }

  try {
    const llm = new Anthropic().messages.stream({
      model: SONNET_MODEL,
      max_tokens: 16000,
      // A study sheet is synthesis, not chat: some thinking earns its keep.
      output_config: { effort: "medium" },
      system: composeSystemPrompt({ naeContext, folioCanon }),
      messages: [{ role: "user", content: buildRequest(sources, course, timeZone) }],
    });
    const final = await llm.finalMessage();
    if (final.stop_reason === "refusal") {
      console.warn(`Folio: Cleo declined a review sheet — category=${final.stop_details?.category ?? "none"}`);
      return new Response("Cleo declined to write this one.", { status: 422 });
    }
    const markdown = final.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    if (!markdown) return new Response("Cleo didn't write anything — try again.", { status: 502 });
    if (final.stop_reason === "max_tokens") {
      console.warn("Folio: review sheet hit max_tokens; returning what was written");
    }
    console.log(
      `Folio: review sheet — sources=${sources.length} input=${final.usage.input_tokens} output=${final.usage.output_tokens}`,
    );
    return Response.json({ markdown, sources: sources.length });
  } catch (e) {
    console.error("Folio: review sheet failed", e);
    return new Response("Cleo hit an error writing the review sheet.", { status: 502 });
  }
}
