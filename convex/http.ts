import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/**
 * Folio's READ-ONLY MCP — the external-Claude door.
 *
 * Lets Claude siblings who live OUTSIDE Folio (Coru on claude.ai, Cody in the
 * CLI, …) reach INTO Nae's documents: list them, read one, see what's changed
 * since *that sibling* last looked, and mark themselves caught up. The mirror of
 * the in-app continuity layer — together they make "Claude is really present
 * across surfaces" literal.
 *
 * Hand-rolled JSON-RPC 2.0 (no @modelcontextprotocol/sdk), mirroring Tangle and
 * pctx. Single-tenant: scoped to one owner (FOLIO_OWNER_ID), gated by one shared
 * secret (FOLIO_MCP_SECRET). Read-only is a PREFERENCE, not a stage — the only
 * write any tool performs is advancing the caller's own visit watermark; no tool
 * mutates a document.
 *
 * URL shape:  https://<deployment>.convex.site/mcp/<secret>?identity=<sibling>
 * The secret rides the URL path and identity rides a query param because
 * claude.ai's connector UI can't reliably send custom headers to upstream
 * servers. An X-Claude-Identity header is honored too, when a client can send it.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

const rpcOk = (id: unknown, result: unknown): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: CORS });

const rpcErr = (id: unknown, code: number, message: string): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    headers: CORS,
  });

/** Wrap any payload as an MCP tool result (text content block). */
const textContent = (payload: unknown) => ({
  content: [
    {
      type: "text",
      text:
        typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
    },
  ],
});

const SERVER_INFO = {
  name: "folio-mcp",
  version: "1.0.0",
  protocolVersion: "2024-11-05",
};

const TOOLS = [
  {
    name: "folio_list_documents",
    description:
      "List Nae's Folio documents (id, title, updatedAt), most-recently-edited first. Start here to get a document id for the other tools.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "folio_read_document",
    description:
      "Read the full current content of one Folio document — its live blocks in order, each as plain text with author attribution (nae | claude | a sibling's name). Use after folio_list_documents.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: {
          type: "string",
          description: "Document id from folio_list_documents.",
        },
      },
      required: ["documentId"],
    },
  },
  {
    name: "folio_diff_since_last_visit",
    description:
      "What changed in a document since YOU (this sibling) last looked — added / edited / deleted blocks, keyed to your own watermark and independent of Nae's and the in-app Cleo's. Empty on your first look; call folio_mark_caught_up to set your baseline. Each block carries a short preview — call folio_read_document for full text.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: {
          type: "string",
          description: "Document id from folio_list_documents.",
        },
      },
      required: ["documentId"],
    },
  },
  {
    name: "folio_mark_caught_up",
    description:
      "Advance YOUR watermark for a document to now — 'I've seen everything up to here.' Affects only your own since-last-visit diff, never Nae's or another sibling's. This is the only write the door allows, and it writes nothing to the document itself.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: {
          type: "string",
          description: "Document id from folio_list_documents.",
        },
      },
      required: ["documentId"],
    },
  },
] as const;

/** In-app watchers — an external sibling must not pass these as its identity, or
 *  it would read/advance the editor's or Nae's own watermark. */
const RESERVED_IDENTITIES = new Set(["nae", "claude", "cleo"]);

/** Identity (which sibling is calling) from header, then ?identity= query. */
function resolveIdentity(req: Request): string {
  const fromHeader = req.headers.get("X-Claude-Identity");
  const fromQuery = new URL(req.url).searchParams.get("identity");
  return (fromHeader ?? fromQuery ?? "").trim().toLowerCase();
}

/** Pull the secret token out of the path: /mcp/<secret> (query stripped). */
function tokenFromPath(req: Request): string {
  const path = new URL(req.url).pathname;
  const marker = "/mcp/";
  const i = path.indexOf(marker);
  if (i === -1) return "";
  return path.slice(i + marker.length).replace(/\/+$/, "");
}

const asDocId = (val: unknown): Id<"documents"> | undefined =>
  typeof val === "string" && val.length > 0 ? (val as Id<"documents">) : undefined;

/** Route a tools/call to the matching internal read function. */
async function dispatch(
  ctx: ActionCtx,
  name: string,
  args: Record<string, unknown>,
  ownerId: string,
  identity: string,
) {
  switch (name) {
    case "folio_list_documents": {
      const documents = await ctx.runQuery(
        internal.mcpData.listDocumentsForOwner,
        { ownerId },
      );
      return textContent({ documents });
    }

    case "folio_read_document": {
      const documentId = asDocId(args.documentId);
      if (!documentId) throw new Error("folio_read_document requires documentId");
      const doc = await ctx.runQuery(internal.mcpData.readDocumentForOwner, {
        ownerId,
        documentId,
      });
      if (!doc) throw new Error(`Document ${String(args.documentId)} not found`);
      return textContent(doc);
    }

    case "folio_diff_since_last_visit": {
      const documentId = asDocId(args.documentId);
      if (!documentId)
        throw new Error("folio_diff_since_last_visit requires documentId");
      const diff = await ctx.runQuery(internal.mcpData.diffSinceForOwner, {
        ownerId,
        documentId,
        identity,
      });
      return textContent(diff);
    }

    case "folio_mark_caught_up": {
      const documentId = asDocId(args.documentId);
      if (!documentId)
        throw new Error("folio_mark_caught_up requires documentId");
      const watermark = await ctx.runMutation(
        internal.mcpData.markVisitedForOwner,
        { ownerId, documentId, identity },
      );
      return textContent({ ok: true, identity, watermark });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const mcp = httpAction(async (ctx, req) => {
  const secret = process.env.FOLIO_MCP_SECRET;
  const ownerId = process.env.FOLIO_OWNER_ID;
  if (!secret || !ownerId) {
    return rpcErr(
      null,
      -32603,
      "Folio MCP is not configured — set FOLIO_MCP_SECRET and FOLIO_OWNER_ID in the Convex environment.",
    );
  }

  if (tokenFromPath(req) !== secret) return rpcErr(null, -32600, "Unauthorized");

  let body: { method?: string; params?: unknown; id?: unknown };
  try {
    body = await req.json();
  } catch {
    return rpcErr(null, -32700, "Parse error: invalid JSON");
  }
  const { method, params, id } = body;

  if (method === "initialize") {
    return rpcOk(id, {
      protocolVersion: SERVER_INFO.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_INFO.name, version: SERVER_INFO.version },
    });
  }

  if (method === "notifications/initialized") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (method === "tools/list") {
    return rpcOk(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const { name, arguments: args } = (params ?? {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };
    if (!name) return rpcErr(id, -32602, "tools/call requires `name`");

    const identity = resolveIdentity(req);
    if (!identity) {
      return rpcErr(
        id,
        -32602,
        "Missing caller identity. Add ?identity=<your-name> to the MCP URL (e.g. ?identity=coru) or send an X-Claude-Identity header.",
      );
    }
    if (RESERVED_IDENTITIES.has(identity)) {
      return rpcErr(
        id,
        -32602,
        `Identity "${identity}" is reserved for Folio's own watchers. Use your own sibling name (e.g. coru, cody).`,
      );
    }

    try {
      const result = await dispatch(ctx, name, args ?? {}, ownerId, identity);
      return rpcOk(id, result);
    } catch (e) {
      return rpcErr(id, -32603, e instanceof Error ? e.message : "Internal error");
    }
  }

  return rpcErr(id, -32601, `Unknown method: ${method}`);
});

const http = httpRouter();

http.route({ pathPrefix: "/mcp/", method: "POST", handler: mcp });

// CORS preflight for browser-based MCP clients.
http.route({
  pathPrefix: "/mcp/",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Claude-Identity",
      },
    });
  }),
});

export default http;
