import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// The other side of documents.remove's undo window: hard-delete documents
// (and cascade to their blocks/visits/reactions) once their soft-delete
// tombstone is older than the retention window in convex/documents.ts.
crons.interval(
  "purge soft-deleted documents",
  { hours: 24 },
  internal.documents.purgeDeleted,
  {},
);

// Block tombstones and reaction history both grow without bound otherwise —
// see the doc comments on purgeOldTombstones / purgeOld for why each is safe.
crons.interval(
  "purge old block tombstones",
  { hours: 24 * 7 },
  internal.blocks.purgeOldTombstones,
  {},
);

crons.interval(
  "cap stored reactions per document",
  { hours: 24 * 7 },
  internal.reactions.purgeOld,
  {},
);

// reactions is frozen (superseded by messages) but its own cap cron stays
// running harmlessly on the empty-going-forward table; messages needs the
// same cap since it's now the table that grows.
crons.interval(
  "cap stored messages per document",
  { hours: 24 * 7 },
  internal.messages.purgeOld,
  {},
);

export default crons;
