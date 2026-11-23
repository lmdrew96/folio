import type { Id } from "@convex/_generated/dataModel";

/** Curated folder colors, stored by key so each theme can set its own shade
 *  (see --folio-folder-* in globals.css). The keys predate the Squid Ink
 *  theme and keep their old names so stored folders need no migration.
 *  Mirrored by COLOR_KEYS in convex/folders.ts. */
export const FOLDER_COLORS = [
  { key: "poppy", name: "Coral" },
  { key: "indigo", name: "Ink blue" },
  { key: "herbs", name: "Sea green" },
  { key: "usugaki", name: "Sand" },
  { key: "violet", name: "Lilac" },
  { key: "mecca", name: "Kelp" },
] as const;

export const folderColorVar = (color: string | undefined): string =>
  color ? `var(--folio-folder-${color})` : "color-mix(in srgb, currentColor 30%, transparent)";

export type Folder = {
  _id: Id<"folders">;
  name: string;
  color?: string;
  parentId?: Id<"folders">;
  createdAt: number;
};

export type FolderSort = "az" | "newest";

export function sortFolders(folders: Folder[], sort: FolderSort): Folder[] {
  return [...folders].sort(
    sort === "newest"
      ? (a, b) => b.createdAt - a.createdAt
      : (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );
}

/** parentId → children, sorted. Top-level folders live under `null`. A folder
 *  whose parent is missing (shouldn't happen — removal re-parents) is treated
 *  as top-level rather than disappearing. */
export function childrenMap(folders: Folder[], sort: FolderSort): Map<Id<"folders"> | null, Folder[]> {
  const ids = new Set(folders.map((f) => f._id));
  const map = new Map<Id<"folders"> | null, Folder[]>();
  for (const f of sortFolders(folders, sort)) {
    const key = f.parentId && ids.has(f.parentId) ? f.parentId : null;
    const list = map.get(key);
    if (list) list.push(f);
    else map.set(key, [f]);
  }
  return map;
}

/** Root-first chain of folders ending at `id` — for the breadcrumb. */
export function ancestry(folders: Folder[], id: Id<"folders">): Folder[] {
  const byId = new Map(folders.map((f) => [f._id, f]));
  const chain: Folder[] = [];
  let cursor = byId.get(id);
  while (cursor && !chain.includes(cursor)) {
    chain.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return chain;
}

/** `id` plus every folder beneath it. */
export function subtreeIds(
  children: Map<Id<"folders"> | null, Folder[]>,
  id: Id<"folders">,
): Set<Id<"folders">> {
  const out = new Set<Id<"folders">>([id]);
  const stack = [id];
  while (stack.length) {
    for (const child of children.get(stack.pop()!) ?? []) {
      if (!out.has(child._id)) {
        out.add(child._id);
        stack.push(child._id);
      }
    }
  }
  return out;
}

/** Depth-first, indented flat list — for pickers ("Move to…"). */
export function flattenTree(
  children: Map<Id<"folders"> | null, Folder[]>,
): { folder: Folder; depth: number }[] {
  const out: { folder: Folder; depth: number }[] = [];
  const walk = (parent: Id<"folders"> | null, depth: number) => {
    for (const f of children.get(parent) ?? []) {
      out.push({ folder: f, depth });
      walk(f._id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
