import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Folio's load-bearing decision: block-as-row, not doc-as-blob.
 *
 * Each top-level editor block is its own row, keyed by a stable `blockId`
 * (TipTap's UniqueID). That makes per-block attribution and diff-since-visit
 * native to the data model instead of a parsing problem forever.
 *
 * Patch 1 lays the schema and turns the metadata columns ON even though they
 * aren't wired yet — so attribution (Patch 3) and diff (Patch 4) need no migration.
 */
export default defineSchema({
  documents: defineTable({
    ownerId: v.string(), // Clerk user id (identity.subject)
    title: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    // Soft-delete tombstone — lets the client offer an "Undo" toast instead of
    // an irreversible delete. The daily purge cron (convex/crons.ts) hard-deletes
    // documents (and cascades to their blocks/visits/reactions) once this is
    // older than the retention window.
    deletedAt: v.optional(v.number()),
    // Prose column font — a key from the curated list in src/lib/fonts.ts.
    // Unset/unknown falls back to the default (Fraunces) client-side.
    fontFamily: v.optional(v.string()),
    // Optional target word count — shows progress instead of a raw tally in
    // the editor's word-count toggle. Unset = no goal.
    wordGoal: v.optional(v.number()),
  }).index("by_owner", ["ownerId"]),

  blocks: defineTable({
    documentId: v.id("documents"),
    blockId: v.string(), // TipTap UniqueID — stable across edits
    order: v.number(), // fractional index for cheap reordering (Patch 2)
    type: v.string(), // paragraph | heading | etc.
    content: v.any(), // ProseMirror node JSON for this block

    // --- metadata slots: exist now, populated in later patches (no migration) ---
    author: v.optional(v.string()), // Patch 3 — who wrote/last touched it
    authorName: v.optional(v.string()), // display name snapshotted at write time (see users table)
    createdAt: v.number(),
    lastEditedAt: v.number(),
    deletedAt: v.optional(v.number()), // Patch 4 — soft-delete tombstone for diff
    previouslyDraftedBy: v.optional(v.string()), // v1 lineage
    // The block's content immediately before its most recent edit — lets the
    // diff panel render an actual word-level change instead of just current
    // text. Overwritten on every edit (single prior snapshot, not a history).
    previousContent: v.optional(v.any()),
  })
    .index("by_document", ["documentId"])
    .index("by_document_block", ["documentId", "blockId"]),

  // Patch 4 — per-(document, user) "last looked at" watermark. A diff query
  // compares block timestamps against this to surface what changed since.
  visits: defineTable({
    documentId: v.id("documents"),
    userId: v.string(), // who looked (nae | claude)
    lastVisitedAt: v.number(),
  }).index("by_doc_user", ["documentId", "userId"]),

  // v0 continuity layer — the in-app Claude's own memory of this document.
  // Frozen: superseded by `messages` below, which unifies this one-shot
  // reaction history with real two-way conversation. Kept in place (not
  // deleted) as dormant history/rollback path; nothing writes to it anymore.
  reactions: defineTable({
    documentId: v.id("documents"),
    content: v.string(), // what the sibling said (markdown)
    summary: v.string(), // terse note of what it reacted to ("2 added · 1 edited")
    createdAt: v.number(),
  }).index("by_document", ["documentId"]),

  // v1 continuity layer — a real, two-sided conversation with Cleo, per
  // document. Replaces `reactions`' paraphrase-based "memory" with actual
  // turn history sent to the model. `kind: "reaction"` rows are Cleo's
  // response to a diff-since-last-look (the old `reactions` shape, carrying
  // a `summary`); `kind: "chat"` rows are free-text turns from either side.
  messages: defineTable({
    documentId: v.id("documents"),
    // Human turns store identity.subject; Cleo's own turns store "claude".
    // Was a v.union(v.literal("nae"), v.literal("claude")) before sharing —
    // widened so any collaborator, not just Nae, can be a turn's author.
    author: v.string(),
    authorName: v.optional(v.string()), // display name snapshotted at write time
    kind: v.union(v.literal("chat"), v.literal("reaction")),
    content: v.string(), // markdown
    summary: v.optional(v.string()), // set only on kind:"reaction" rows
    createdAt: v.number(),
  }).index("by_document", ["documentId"]),

  // Durable, Clerk-independent profile row — kept current by a client-side
  // sync effect (UserSync) rather than a webhook. Exists so attribution and
  // invite-by-email have a real displayName/email to resolve against instead
  // of depending on what the Clerk JWT template happens to carry.
  users: defineTable({
    userId: v.string(), // identity.subject — same field documents.ownerId uses
    email: v.string(), // lowercased; sourced client-side from Clerk's useUser()
    displayName: v.string(),
  })
    .index("by_user", ["userId"])
    .index("by_email", ["email"]),

  // One row per (document, viewer) — "who's here right now." Upserted by a
  // client-side heartbeat while a document is open and deleted on a clean
  // unmount; the stale-purge cron (convex/crons.ts) clears rows a crashed or
  // closed tab never got to clean up itself.
  presence: defineTable({
    documentId: v.id("documents"),
    userId: v.string(), // identity.subject
    displayName: v.string(),
    lastSeenAt: v.number(),
  })
    .index("by_document", ["documentId"])
    .index("by_doc_user", ["documentId", "userId"]),

  // One row per (document, invited email) — the sharing grant. An accepted
  // row (userId + acceptedAt set) is editor access to the document; no
  // separate `role` field yet since editor is the only non-owner role (v1).
  documentShares: defineTable({
    documentId: v.id("documents"),
    invitedEmail: v.string(), // lowercased at write time
    userId: v.optional(v.string()), // identity.subject, filled once resolved
    displayName: v.optional(v.string()), // snapshotted at resolution time
    invitedAt: v.number(),
    acceptedAt: v.optional(v.number()),
  })
    .index("by_document", ["documentId"])
    .index("by_document_and_user", ["documentId", "userId"])
    .index("by_email", ["invitedEmail"])
    .index("by_user", ["userId"]),

  // A lightweight personal contacts list — remembered collaborators you can
  // pick from instead of retyping an email every time you share a document.
  // One-directional (your own list, not a mutual "friend request"):
  // populated automatically whenever you invite someone via
  // documents.invite, and grants no access by itself, so it never needs the
  // other person's consent.
  friends: defineTable({
    ownerId: v.string(), // identity.subject of whoever saved this contact
    friendEmail: v.string(), // lowercased
    friendUserId: v.optional(v.string()), // resolved once they have a Folio account
    friendDisplayName: v.optional(v.string()), // kept current by users.upsertUser
    addedAt: v.number(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_owner_and_email", ["ownerId", "friendEmail"])
    .index("by_friend_email", ["friendEmail"]),
});
