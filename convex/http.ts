import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { KEY_PREFIX, sha256Hex, shouldTouch, watermarkId } from "./apiKeys";

/**
 * Folio's READ-ONLY MCP — any user's door for the AI of their choice.
 *
 * Each user mints personal API keys in the app ("Connect an AI" on the desk,
 * convex/apiKeys.ts). A key reaches exactly what its owner can open in Folio —
 * their documents plus ones shared with them — and nothing else. Read-only is
 * a PREFERENCE, not a stage: the only writes any tool performs advance the
 * key's own since-last-look watermarks; no tool mutates a document.
 *
 * Two ways to present a key:
 *   https://<deployment>.convex.site/mcp/fo_…          (key in the path)
 *   https://<deployment>.convex.site/mcp  + Authorization: Bearer fo_…
 * The path form exists because claude.ai's connector UI can't send custom
 * headers; clients that can (Claude Code, Cursor, …) may use either.
 *
 * Hand-rolled JSON-RPC 2.0 (no @modelcontextprotocol/sdk). Responses are plain
 * JSON, which the Streamable HTTP transport permits; there are no
 * server-initiated messages, so GET (the SSE stream) is 405.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

const rpcOk = (id: unknown, result: unknown): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: CORS });

const rpcErr = (id: unknown, code: number, message: string, status = 200): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status,
    headers: CORS,
  });

/** Wrap any payload as an MCP tool result (text content block). */
const textContent = (payload: unknown) => ({
  content: [
    {
      type: "text",
      text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
    },
  ],
});

const SERVER_INFO = { name: "folio", version: "2.0.0" };
/** Newest first. The client's requested version is echoed when we speak it. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const TOOLS = [
  {
    name: "folio_list_documents",
    description:
      "List the Folio documents this key can read — the user's own plus any shared with them (`shared: true`) — as id, title, createdAt, updatedAt, most-recently-edited first. Start here to get a document id for the other tools.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "folio_read_document",
    description:
      "Read the full current content of one Folio document — its live blocks in order, each as markdown text (headings, lists, tables, bold/italic/links preserved) with author attribution (a person's display name, or \"claude\" for Folio's in-app assistant). Use after folio_list_documents.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Document id from folio_list_documents." },
      },
      required: ["documentId"],
    },
  },
  {
    name: "folio_search",
    description:
      "Full-text search across every Folio document this key can read (own + shared). Case-insensitive; every word of the query must appear in a block. Returns the best-matching blocks first — each with documentId, documentTitle, blockId, blockType, a short snippet around the match, author and updatedAt — plus totalHits. Use it to answer \"where did I write about X?\" without reading every document; follow up with folio_read_document for full context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to find." },
        limit: {
          type: "number",
          description: "Max hits to return (default 20, max 100).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "folio_diff_since_last_visit",
    description:
      "What changed in a document since YOU (this key) last looked — added / edited / deleted blocks, keyed to this key's own watermark and independent of the writer's and any other AI's. Empty on your first look; call folio_mark_caught_up to set your baseline. Each block carries a short preview — call folio_read_document for full text.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Document id from folio_list_documents." },
      },
      required: ["documentId"],
    },
  },
  {
    name: "folio_mark_caught_up",
    description:
      "Advance YOUR (this key's) watermark for a document to now — 'I've seen everything up to here.' Affects only your own since-last-visit diff. Watermarks are the only thing the door writes — nothing is ever written to the document itself.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Document id from folio_list_documents." },
      },
      required: ["documentId"],
    },
  },
  {
    name: "folio_whats_new",
    description:
      "One-call catch-up: every document this key can read that changed since YOU (this key) last looked at it, most recently changed first, with addedCount / editedCount / deletedCount blocks. Unchanged documents are left out. Documents you've never looked at appear with hasWatermark: false and null counts — mark them caught up to start tracking. Counts only; call folio_diff_since_last_visit on a document for the actual changes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "folio_mark_all_caught_up",
    description:
      "Advance YOUR (this key's) watermark on every document you can read to now — folio_mark_caught_up for all of them at once. Affects only your own since-last-visit tracking; writes nothing to any document.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

/** The presented key: Authorization: Bearer first, then the /mcp/<key> path. */
function presentedKey(req: Request): string {
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const path = new URL(req.url).pathname;
  const i = path.indexOf("/mcp/");
  return i === -1 ? "" : path.slice(i + "/mcp/".length).replace(/\/+$/, "");
}

const asDocId = (val: unknown): Id<"documents"> | undefined =>
  typeof val === "string" && val.length > 0 ? (val as Id<"documents">) : undefined;

/** Route a tools/call to the matching internal read function. */
async function dispatch(
  ctx: ActionCtx,
  name: string,
  args: Record<string, unknown>,
  userId: string,
  watermark: string,
) {
  switch (name) {
    case "folio_list_documents": {
      const documents = await ctx.runQuery(internal.mcpData.listDocumentsForUser, { userId });
      return textContent({ documents });
    }

    case "folio_read_document": {
      const documentId = asDocId(args.documentId);
      if (!documentId) throw new Error("folio_read_document requires documentId");
      const doc = await ctx.runQuery(internal.mcpData.readDocumentForUser, {
        userId,
        documentId,
      });
      if (!doc) throw new Error(`Document ${String(args.documentId)} not found`);
      return textContent(doc);
    }

    case "folio_search": {
      if (typeof args.query !== "string") throw new Error("folio_search requires query");
      const result = await ctx.runQuery(internal.mcpData.searchForUser, {
        userId,
        query: args.query,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return textContent(result);
    }

    case "folio_diff_since_last_visit": {
      const documentId = asDocId(args.documentId);
      if (!documentId) throw new Error("folio_diff_since_last_visit requires documentId");
      const diff = await ctx.runQuery(internal.mcpData.diffSinceForUser, {
        userId,
        documentId,
        watermark,
      });
      return textContent(diff);
    }

    case "folio_mark_caught_up": {
      const documentId = asDocId(args.documentId);
      if (!documentId) throw new Error("folio_mark_caught_up requires documentId");
      const at = await ctx.runMutation(internal.mcpData.markVisitedForUser, {
        userId,
        documentId,
        watermark,
      });
      return textContent({ ok: true, watermark: at });
    }

    case "folio_whats_new": {
      const result = await ctx.runQuery(internal.mcpData.whatsNewForUser, { userId, watermark });
      return textContent(result);
    }

    case "folio_mark_all_caught_up": {
      const result = await ctx.runMutation(internal.mcpData.markAllVisitedForUser, {
        userId,
        watermark,
      });
      return textContent({ ok: true, ...result });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const mcp = httpAction(async (ctx, req) => {
  const presented = presentedKey(req);
  if (!presented.startsWith(KEY_PREFIX)) {
    return rpcErr(null, -32600, "Missing or malformed Folio API key.", 401);
  }
  const key = await ctx.runQuery(internal.apiKeys.resolve, {
    keyHash: await sha256Hex(presented),
  });
  if (!key) return rpcErr(null, -32600, "Unknown or revoked Folio API key.", 401);
  if (shouldTouch(key.lastUsedAt)) {
    await ctx.runMutation(internal.apiKeys.touch, { keyId: key.keyId });
  }

  let body: { method?: string; params?: unknown; id?: unknown };
  try {
    body = await req.json();
  } catch {
    return rpcErr(null, -32700, "Parse error: invalid JSON");
  }
  const { method, params, id } = body;

  if (method === "initialize") {
    const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    const protocolVersion =
      typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : PROTOCOL_VERSIONS[0];
    return rpcOk(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }

  // Notifications (no id) get no JSON-RPC response.
  if (typeof method === "string" && method.startsWith("notifications/")) {
    return new Response(null, { status: 202, headers: CORS });
  }

  if (method === "ping") return rpcOk(id, {});

  if (method === "tools/list") return rpcOk(id, { tools: TOOLS });

  if (method === "tools/call") {
    const { name, arguments: args } = (params ?? {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };
    if (!name) return rpcErr(id, -32602, "tools/call requires `name`");
    try {
      const result = await dispatch(ctx, name, args ?? {}, key.userId, watermarkId(key.keyId));
      return rpcOk(id, result);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Internal error";
      // A malformed or wrong-table id fails Convex's validator with an internal
      // message — to the caller it's just a document that isn't there.
      if (message.includes("ArgumentValidationError")) {
        return rpcErr(id, -32602, `Document ${String(args?.documentId)} not found`);
      }
      return rpcErr(id, -32603, message);
    }
  }

  return rpcErr(id, -32601, `Unknown method: ${method}`);
});

// No server-initiated stream to offer.
const noStream = httpAction(
  async () =>
    new Response(null, { status: 405, headers: { ...CORS, Allow: "POST, OPTIONS" } }),
);

// CORS preflight for browser-based MCP clients.
const preflight = httpAction(
  async () =>
    new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
      },
    }),
);

const http = httpRouter();

for (const route of [{ path: "/mcp" }, { pathPrefix: "/mcp/" }] as const) {
  http.route({ ...route, method: "POST", handler: mcp });
  http.route({ ...route, method: "GET", handler: noStream });
  http.route({ ...route, method: "OPTIONS", handler: preflight });
}

export default http;
