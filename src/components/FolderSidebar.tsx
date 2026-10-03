"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useDropdownMenu } from "@/lib/useDropdownMenu";
import { useKeepInViewport } from "@/lib/useKeepInViewport";
import { dragSource, useFilingDrop } from "@/lib/dragFiling";
import {
  FOLDER_COLORS,
  flattenTree,
  folderColorVar,
  subtreeIds,
  type Folder,
  type FolderSort,
} from "@/lib/folders";

export type DeskView =
  | { kind: "all" }
  | { kind: "unfiled" }
  | { kind: "folder"; id: Id<"folders"> };

type Children = Map<Id<"folders"> | null, Folder[]>;

/** Past this many folders the sidebar grows a filter box; below it the box is
 *  just one more thing to look at. */
const FILTER_THRESHOLD = 6;

const ROW =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition";
const ROW_IDLE = "text-foreground/70 hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10";
const ROW_ACTIVE = "bg-black/10 text-foreground dark:bg-white/15";

export function FolderDot({ color }: { color?: string }) {
  return (
    <span
      aria-hidden="true"
      className="h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ background: folderColorVar(color) }}
    />
  );
}

/** Inline name field for rename/new — Enter commits, Escape/blur-empty cancels. */
function NameField({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    const trimmed = value.trim();
    if (trimmed && trimmed !== initial) onCommit(trimmed);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      aria-label="Folder name"
      value={value}
      maxLength={80}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
      className="w-full min-w-0 rounded-md border border-foreground/15 bg-[var(--folio-paper)] px-2 py-1 text-sm text-foreground outline-none focus:ring-2 focus:ring-[var(--folio-attr-sibling)]"
    />
  );
}

/** The ⋯ menu on a folder row. Move and Delete swap the panel's contents
 *  rather than opening a second popover. */
function FolderActions({
  folder,
  folders,
  tree,
  onRename,
  onNewSubfolder,
  onDeleted,
}: {
  folder: Folder;
  folders: Folder[];
  tree: Children;
  onRename: () => void;
  onNewSubfolder: () => void;
  onDeleted: () => void;
}) {
  const { open, setOpen, close, rootRef, triggerRef, onTriggerKeyDown, onPanelKeyDown } =
    useDropdownMenu();
  const panelRef = useKeepInViewport<HTMLDivElement>(open);
  const [mode, setMode] = useState<"main" | "move" | "delete">("main");
  const setColor = useMutation(api.folders.setColor);
  const move = useMutation(api.folders.move);
  const remove = useMutation(api.folders.remove);

  // Swapping the panel's contents unmounts the focused item — put focus on
  // the new first item so keyboard users aren't dropped onto <body>.
  useEffect(() => {
    if (!open) return;
    rootRef.current
      ?.querySelector<HTMLButtonElement>('[role="menu"] button:not(:disabled)')
      ?.focus();
  }, [mode, open, rootRef]);

  const parent = folder.parentId ? folders.find((f) => f._id === folder.parentId) : undefined;
  const blocked = subtreeIds(tree, folder._id);
  const destinations = flattenTree(tree).filter(({ folder: f }) => !blocked.has(f._id));

  const item =
    "block w-full px-3 py-1.5 text-left text-sm text-foreground/80 transition hover:bg-black/5 hover:text-foreground disabled:opacity-40 dark:hover:bg-white/10";

  const act = (fn: () => Promise<unknown>) => {
    close();
    fn().catch((e) => console.error("Folio: folder action failed", e));
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        // Every opening starts on the main panel, whatever it was left on.
        onClick={() => {
          setMode("main");
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (!open) setMode("main");
          onTriggerKeyDown(e);
        }}
        aria-label={`Actions for ${folder.name}`}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Folder actions"
        className={`flex h-6 w-6 items-center justify-center rounded text-foreground/40 transition hover:bg-black/5 hover:text-foreground focus-visible:opacity-100 dark:hover:bg-white/10 ${
          open ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-lg:opacity-100"
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M5 12h.01M12 12h.01M19 12h.01" />
        </svg>
      </button>
      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label={`${folder.name} actions`}
          onKeyDown={onPanelKeyDown}
          className="absolute right-0 top-7 z-30 max-h-80 w-56 overflow-y-auto rounded-lg border border-foreground/10 bg-[var(--folio-paper)] py-1 shadow-md"
        >
          {mode === "main" && (
            <>
              <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onRename(); }}>
                Rename
              </button>
              <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onNewSubfolder(); }}>
                New subfolder
              </button>
              <button type="button" role="menuitem" className={item} onClick={() => setMode("move")}>
                Move to…
              </button>
              <div className="border-t border-foreground/10 px-3 pb-1 pt-2">
                <span className="text-xs text-foreground/50">Color</span>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {FOLDER_COLORS.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      role="menuitemradio"
                      aria-checked={folder.color === c.key}
                      aria-label={c.name}
                      title={c.name}
                      onClick={() => act(() => setColor({ folderId: folder._id, color: c.key }))}
                      className={`h-5 w-5 rounded-full border transition hover:scale-110 ${
                        folder.color === c.key
                          ? "border-foreground ring-1 ring-foreground"
                          : "border-black/15 dark:border-white/20"
                      }`}
                      style={{ background: folderColorVar(c.key) }}
                    />
                  ))}
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={!folder.color}
                    onClick={() => act(() => setColor({ folderId: folder._id, color: null }))}
                    className="rounded px-1.5 text-xs text-foreground/60 transition hover:text-foreground"
                  >
                    None
                  </button>
                </div>
              </div>
              <button
                type="button"
                role="menuitem"
                className={`${item} border-t border-foreground/10`}
                onClick={() => setMode("delete")}
              >
                Delete folder…
              </button>
            </>
          )}
          {mode === "move" && (
            <>
              <p className="px-3 pb-1 pt-1.5 text-xs text-foreground/50">Move “{folder.name}” to</p>
              <button
                type="button"
                role="menuitem"
                disabled={!folder.parentId}
                className={item}
                onClick={() => act(() => move({ folderId: folder._id, parentId: null }))}
              >
                Top level
              </button>
              {destinations.map(({ folder: f, depth }) => (
                <button
                  key={f._id}
                  type="button"
                  role="menuitem"
                  disabled={f._id === folder.parentId}
                  className={`${item} flex items-center gap-2`}
                  style={{ paddingLeft: `${12 + depth * 12}px` }}
                  onClick={() => act(() => move({ folderId: folder._id, parentId: f._id }))}
                >
                  <FolderDot color={f.color} />
                  <span className="truncate">{f.name}</span>
                </button>
              ))}
            </>
          )}
          {mode === "delete" && (
            <div className="px-3 py-1.5">
              <p className="text-sm text-foreground/80">
                Delete “{folder.name}”? Nothing inside is deleted — its documents and
                folders move to {parent ? `“${parent.name}”` : "the top level"}.
              </p>
              <div className="mt-2 flex justify-end gap-1">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setMode("main")}
                  className="rounded px-2 py-1 text-xs text-foreground/60 transition hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() =>
                    act(async () => {
                      await remove({ folderId: folder._id });
                      onDeleted();
                    })
                  }
                  className="rounded-md px-2 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                >
                  Delete folder
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A folder's row button: selects it, and is both draggable (to nest the
 *  folder elsewhere) and a drop target (to file a document or folder into it). */
function FolderButton({
  folder,
  tree,
  active,
  count,
  onSelect,
  onRename,
}: {
  folder: Folder;
  tree: Children;
  active: boolean;
  count: number;
  onSelect: () => void;
  onRename: () => void;
}) {
  const drop = useFilingDrop(folder._id, tree, { color: folder.color });
  return (
    <button
      type="button"
      {...dragSource({ kind: "folder", id: folder._id, parentId: folder.parentId ?? null })}
      {...drop.props}
      style={drop.style}
      onClick={onSelect}
      onDoubleClick={onRename}
      aria-current={active ? "page" : undefined}
      className={`${ROW} ${active ? ROW_ACTIVE : ROW_IDLE}`}
    >
      <FolderDot color={folder.color} />
      <span className="min-w-0 flex-1 truncate">{folder.name}</span>
      {count > 0 && <span className="text-xs tabular-nums text-foreground/40">{count}</span>}
    </button>
  );
}

/**
 * The desk's folder column: All / Unfiled, then the owner's folder tree.
 * Selecting a row changes the view; each folder row carries its own ⋯ menu.
 */
export function FolderSidebar({
  folders,
  tree,
  counts,
  totalCount,
  unfiledCount,
  view,
  onSelect,
  sort,
  onSortChange,
}: {
  folders: Folder[];
  tree: Children;
  counts: Map<Id<"folders">, number>;
  totalCount: number;
  unfiledCount: number;
  view: DeskView;
  onSelect: (view: DeskView) => void;
  sort: FolderSort;
  onSortChange: (sort: FolderSort) => void;
}) {
  const create = useMutation(api.folders.create);
  const rename = useMutation(api.folders.rename);
  const [renamingId, setRenamingId] = useState<Id<"folders"> | null>(null);
  // Where a pending "new folder" name field is showing: null = top level.
  const [creatingIn, setCreatingIn] = useState<Id<"folders"> | null | undefined>(undefined);
  const [collapsed, setCollapsed] = useState<Set<Id<"folders">>>(() => new Set());
  const [filter, setFilter] = useState("");

  const selectedId = view.kind === "folder" ? view.id : null;
  // Drop a document on Unfiled to unfile it; a folder on the Folders
  // header to move it to the top level.
  const unfiledDrop = useFilingDrop(null, tree, { only: "doc" });
  const topLevelDrop = useFilingDrop(null, tree, { only: "folder" });

  // Reveal a newly selected folder by expanding its ancestors — adjusted
  // during render when the selection changes (not in an effect), and only
  // then, so collapsing a branch afterwards still sticks.
  const [revealedFor, setRevealedFor] = useState<Id<"folders"> | null>(null);
  if (selectedId !== revealedFor) {
    setRevealedFor(selectedId);
    if (selectedId) {
      const byId = new Map(folders.map((f) => [f._id, f]));
      const ancestors: Id<"folders">[] = [];
      let cursor = byId.get(selectedId)?.parentId;
      while (cursor && !ancestors.includes(cursor)) {
        ancestors.push(cursor);
        cursor = byId.get(cursor)?.parentId;
      }
      if (ancestors.some((id) => collapsed.has(id))) {
        const next = new Set(collapsed);
        ancestors.forEach((id) => next.delete(id));
        setCollapsed(next);
      }
    }
  }

  const q = filter.trim().toLowerCase();
  // Filtering keeps every match plus the ancestors that lead to it.
  const visible: Set<Id<"folders">> | null = q
    ? (() => {
        const byId = new Map(folders.map((f) => [f._id, f]));
        const keep = new Set<Id<"folders">>();
        for (const f of folders) {
          if (!f.name.toLowerCase().includes(q)) continue;
          let cursor: Folder | undefined = f;
          while (cursor && !keep.has(cursor._id)) {
            keep.add(cursor._id);
            cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
          }
        }
        return keep;
      })()
    : null;

  const newFolder = (parentId: Id<"folders"> | null) => {
    if (parentId) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(parentId);
        return next;
      });
    }
    setCreatingIn(parentId);
  };

  const commitNew = async (name: string) => {
    const parentId = creatingIn ?? undefined;
    setCreatingIn(undefined);
    try {
      const id = await create({ name, parentId });
      onSelect({ kind: "folder", id });
    } catch (e) {
      console.error("Folio: couldn't create folder", e);
    }
  };

  const renderLevel = (parent: Id<"folders"> | null, depth: number) => {
    const list = (tree.get(parent) ?? []).filter((f) => !visible || visible.has(f._id));
    const pending = creatingIn === parent;
    if (list.length === 0 && !pending) return null;
    return (
      <ul className="flex flex-col gap-0.5">
        {pending && (
          <li style={{ paddingLeft: `${depth * 14 + 8}px` }}>
            <NameField initial="" onCommit={commitNew} onCancel={() => setCreatingIn(undefined)} />
          </li>
        )}
        {list.map((f) => {
          const kids = tree.get(f._id) ?? [];
          const hasKids = kids.length > 0;
          // A filter forces matching branches open.
          const isOpen = !!visible || !collapsed.has(f._id);
          const count = counts.get(f._id) ?? 0;
          return (
            <li key={f._id}>
              <div className="group flex items-center gap-0.5" style={{ paddingLeft: `${depth * 14}px` }}>
                {hasKids ? (
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(f._id)) next.delete(f._id);
                        else next.add(f._id);
                        return next;
                      })
                    }
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? "Collapse" : "Expand"} ${f.name}`}
                    className="flex h-6 w-4 shrink-0 items-center justify-center text-foreground/40 transition hover:text-foreground"
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      className={`transition-transform ${isOpen ? "rotate-90" : ""}`}
                    >
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                  </button>
                ) : (
                  <span className="w-4 shrink-0" />
                )}
                {renamingId === f._id ? (
                  <NameField
                    initial={f.name}
                    onCommit={(name) => {
                      setRenamingId(null);
                      rename({ folderId: f._id, name }).catch((e) =>
                        console.error("Folio: rename failed", e),
                      );
                    }}
                    onCancel={() => setRenamingId(null)}
                  />
                ) : (
                  <>
                    <FolderButton
                      folder={f}
                      tree={tree}
                      active={selectedId === f._id}
                      count={count}
                      onSelect={() => onSelect({ kind: "folder", id: f._id })}
                      onRename={() => setRenamingId(f._id)}
                    />
                    <FolderActions
                      folder={f}
                      folders={folders}
                      tree={tree}
                      onRename={() => setRenamingId(f._id)}
                      onNewSubfolder={() => newFolder(f._id)}
                      onDeleted={() => {
                        if (selectedId && subtreeIds(tree, f._id).has(selectedId)) {
                          onSelect(f.parentId ? { kind: "folder", id: f.parentId } : { kind: "all" });
                        }
                      }}
                    />
                  </>
                )}
              </div>
              {hasKids && isOpen && renderLevel(f._id, depth + 1)}
              {!hasKids && creatingIn === f._id && renderLevel(f._id, depth + 1)}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <nav aria-label="Folders" className="flex flex-col gap-3">
      <ul className="flex flex-col gap-0.5">
        <li>
          <button
            type="button"
            onClick={() => onSelect({ kind: "all" })}
            aria-current={view.kind === "all" ? "page" : undefined}
            className={`${ROW} ${view.kind === "all" ? ROW_ACTIVE : ROW_IDLE}`}
          >
            <span className="min-w-0 flex-1 truncate">All documents</span>
            <span className="text-xs tabular-nums text-foreground/40">{totalCount}</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            {...unfiledDrop.props}
            style={unfiledDrop.style}
            onClick={() => onSelect({ kind: "unfiled" })}
            aria-current={view.kind === "unfiled" ? "page" : undefined}
            className={`${ROW} ${view.kind === "unfiled" ? ROW_ACTIVE : ROW_IDLE}`}
          >
            <span className="min-w-0 flex-1 truncate">Unfiled</span>
            <span className="text-xs tabular-nums text-foreground/40">{unfiledCount}</span>
          </button>
        </li>
      </ul>

      <div
        {...topLevelDrop.props}
        style={topLevelDrop.style}
        className="flex items-center justify-between gap-2 rounded-md px-2 py-0.5"
      >
        <span className="text-xs font-medium uppercase tracking-wide text-foreground/45">Folders</span>
        <div className="flex items-center gap-1">
          {folders.length > 1 && (
            <button
              type="button"
              onClick={() => onSortChange(sort === "az" ? "newest" : "az")}
              title={sort === "az" ? "Sorted A–Z — switch to newest first" : "Newest first — switch to A–Z"}
              aria-label={`Sort folders: ${sort === "az" ? "A to Z" : "newest first"}`}
              className="rounded px-1.5 py-0.5 text-xs text-foreground/50 transition hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
            >
              {sort === "az" ? "A–Z" : "Newest"}
            </button>
          )}
          <button
            type="button"
            onClick={() => newFolder(null)}
            aria-label="New folder"
            title="New folder"
            className="flex h-6 w-6 items-center justify-center rounded text-foreground/50 transition hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      </div>

      {folders.length > FILTER_THRESHOLD && (
        <input
          type="search"
          aria-label="Filter folders"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter folders…"
          className="mx-2 rounded-md border border-foreground/10 bg-transparent px-2 py-1 text-xs text-foreground outline-none placeholder:text-foreground/40 focus:ring-2 focus:ring-[var(--folio-attr-sibling)]"
        />
      )}

      {folders.length === 0 && creatingIn === undefined ? (
        <p className="px-2 text-xs text-foreground/45">
          No folders yet. Use + to make one, then file documents into it from their cards.
        </p>
      ) : visible && visible.size === 0 ? (
        <p className="px-2 text-xs text-foreground/45">No folders match.</p>
      ) : (
        renderLevel(null, 0)
      )}
    </nav>
  );
}
