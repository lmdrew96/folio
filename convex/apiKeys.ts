import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * Per-user API keys for the MCP door (convex/http.ts). Any Folio user can mint
 * a key for the AI of their choice; the key reaches exactly what its owner can
 * see in the app, read-only.
 *
 * Keys are `fo_` + 64 hex chars (256 random bits). Only a SHA-256 is stored —
 * with that much entropy a plain hash is enough (no salt: there's nothing to
 * brute-force). The plaintext is returned once, at creation.
 */

export const KEY_PREFIX = "fo_";
const MAX_KEYS = 20;
const LABEL_MAX = 50;
/** lastUsedAt is only rewritten when it's this stale, so every MCP request
 *  doesn't cost a write. */
const TOUCH_INTERVAL_MS = 60_000;

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The watermark id a key reads/advances in `visits`. */
export const watermarkId = (keyId: string) => `mcp:${keyId}`;

/**
 * Mint a key. An action, not a mutation: randomness inside queries/mutations
 * comes from Convex's seeded, deterministic PRNG — fine for UI ids, not for a
 * secret. Actions get real crypto.getRandomValues.
 */
export const create = action({
  args: { label: v.string() },
  handler: async (ctx, { label }): Promise<{ key: string; keyId: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const key =
      KEY_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const keyId: string = await ctx.runMutation(internal.apiKeys.store, {
      userId: identity.subject,
      label,
      keyHash: await sha256Hex(key),
      last4: key.slice(-4),
    });
    return { key, keyId };
  },
});

export const store = internalMutation({
  args: { userId: v.string(), label: v.string(), keyHash: v.string(), last4: v.string() },
  handler: async (ctx, { userId, label, keyHash, last4 }) => {
    const existing = await ctx.db
      .query("apiKeys")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_KEYS);
    if (existing.length >= MAX_KEYS) {
      throw new Error(`You can have up to ${MAX_KEYS} keys — revoke one first.`);
    }
    const trimmed = label.trim().slice(0, LABEL_MAX);
    if (!trimmed) throw new Error("Give the key a name — the AI it's for.");
    return await ctx.db.insert("apiKeys", {
      userId,
      keyHash,
      label: trimmed,
      last4,
      createdAt: Date.now(),
    });
  },
});

/** The caller's keys — never the hashes. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .take(MAX_KEYS);
    return keys
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((k) => ({
        _id: k._id,
        label: k.label,
        last4: k.last4,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
      }));
  },
});

/** Revoke a key — it stops working on the very next request. Its watermarks
 *  go too, so a dead key never pins the tombstone purge (blocks.ts). */
export const revoke = mutation({
  args: { keyId: v.id("apiKeys") },
  handler: async (ctx, { keyId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const key = await ctx.db.get(keyId);
    if (!key || key.userId !== identity.subject) throw new Error("Not found");

    for await (const visit of ctx.db
      .query("visits")
      .withIndex("by_user", (q) => q.eq("userId", watermarkId(keyId)))) {
      await ctx.db.delete(visit._id);
    }
    await ctx.db.delete(keyId);
  },
});

/** Key hash → its owner, for the MCP door. null for unknown/revoked keys. */
export const resolve = internalQuery({
  args: { keyHash: v.string() },
  handler: async (ctx, { keyHash }) => {
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_hash", (q) => q.eq("keyHash", keyHash))
      .unique();
    if (!key) return null;
    return { keyId: key._id, userId: key.userId, label: key.label, lastUsedAt: key.lastUsedAt };
  },
});

export const touch = internalMutation({
  args: { keyId: v.id("apiKeys") },
  handler: async (ctx, { keyId }) => {
    const key = await ctx.db.get(keyId);
    if (!key) return;
    const now = Date.now();
    if (key.lastUsedAt === undefined || now - key.lastUsedAt > TOUCH_INTERVAL_MS) {
      await ctx.db.patch(keyId, { lastUsedAt: now });
    }
  },
});

export const shouldTouch = (lastUsedAt: number | undefined) =>
  lastUsedAt === undefined || Date.now() - lastUsedAt > TOUCH_INTERVAL_MS;
