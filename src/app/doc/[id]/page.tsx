import { DocWorkspace } from "@/components/DocWorkspace";
import type { Id } from "@convex/_generated/dataModel";

export default async function DocPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DocWorkspace documentId={id as Id<"documents">} />;
}
