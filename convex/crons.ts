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

export default crons;
