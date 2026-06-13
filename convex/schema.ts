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
  }).index("by_owner", ["ownerId"]),

  blocks: defineTable({
    documentId: v.id("documents"),
    blockId: v.string(), // TipTap UniqueID — stable across edits
    order: v.number(), // fractional index for cheap reordering (Patch 2)
    type: v.string(), // paragraph | heading | etc.
    content: v.any(), // ProseMirror node JSON for this block

    // --- metadata slots: exist now, populated in later patches (no migration) ---
    author: v.optional(v.string()), // Patch 3 — who wrote/last touched it
    createdAt: v.number(),
    lastEditedAt: v.number(),
    deletedAt: v.optional(v.number()), // Patch 4 — soft-delete tombstone for diff
    previouslyDraftedBy: v.optional(v.string()), // v1 lineage
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
});
