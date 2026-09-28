// A block's ProseMirror JSON is stored, sent, and returned as a JSON *string*,
// never as a nested Convex value. Convex caps any value at 16 levels of
// nesting (arguments and return values included), and ProseMirror spends ~4
// levels per list indent — a third-level bullet was enough to make `reconcile`
// reject every save. A string is one level, however deep the list inside it.
//
// Rows written before this change still hold the nested object, so every
// reader goes through decodeContent, which accepts both shapes.

/** Stored/sent block content → ProseMirror JSON. Accepts the legacy nested
 *  object as-is. */
export const decodeContent = (stored: unknown): unknown =>
  typeof stored === "string" ? JSON.parse(stored) : stored;

/** ProseMirror JSON (or an already-encoded string) → the stored string form. */
export const encodeContent = (content: unknown): string =>
  typeof content === "string" ? content : JSON.stringify(content);

// A row holds content + previousContent under Convex's 1 MiB document cap, so
// one block's content gets a bit under half of it.
export const MAX_BLOCK_CONTENT_BYTES = 450_000;
