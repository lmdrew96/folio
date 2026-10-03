"use client";

import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useDropdownMenu } from "@/lib/useDropdownMenu";
import { useKeepInViewport } from "@/lib/useKeepInViewport";
import { flattenTree, type Folder } from "@/lib/folders";
import { FolderDot } from "./FolderSidebar";

/** A document card's "file this" control — owner-only, like delete. */
export function MoveToFolder({
  documentId,
  title,
  folderId,
  tree,
}: {
  documentId: Id<"documents">;
  title: string;
  folderId: Id<"folders"> | undefined;
  tree: Map<Id<"folders"> | null, Folder[]>;
}) {
  const { open, setOpen, close, rootRef, triggerRef, onTriggerKeyDown, onPanelKeyDown } =
    useDropdownMenu();
  const panelRef = useKeepInViewport<HTMLDivElement>(open);
  const moveToFolder = useMutation(api.documents.moveToFolder);
  const destinations = flattenTree(tree);

  const file = (target: Id<"folders"> | null) => {
    close();
    moveToFolder({ documentId, folderId: target }).catch((e) =>
      console.error("Folio: couldn't move document", e),
    );
  };

  const item =
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground/80 transition hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10";

  return (
    <div ref={rootRef} className="absolute right-9 top-2 z-10">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        aria-label={`Move ${title} to a folder`}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Move to folder"
        className="rounded-full p-1.5 text-foreground/40 opacity-60 transition hover:bg-black/5 hover:text-foreground/80 hover:opacity-100 focus-visible:opacity-100 dark:hover:bg-white/10"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
        </svg>
      </button>
      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label="Move to folder"
          onKeyDown={onPanelKeyDown}
          className="absolute right-0 top-8 z-30 max-h-72 w-56 overflow-y-auto rounded-lg border border-foreground/10 bg-[var(--folio-paper)] py-1 shadow-md"
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!folderId}
            onClick={() => file(null)}
            className={`${item} ${!folderId ? "font-medium text-foreground" : ""}`}
          >
            <span className="h-2.5 w-2.5 shrink-0" />
            Unfiled
          </button>
          {destinations.length === 0 ? (
            <p className="px-3 py-1.5 text-xs text-foreground/50">
              No folders yet — make one with + in the folder list.
            </p>
          ) : (
            destinations.map(({ folder, depth }) => (
              <button
                key={folder._id}
                type="button"
                role="menuitemradio"
                aria-checked={folderId === folder._id}
                onClick={() => file(folder._id)}
                className={`${item} ${folderId === folder._id ? "font-medium text-foreground" : ""}`}
                style={{ paddingLeft: `${12 + depth * 12}px` }}
              >
                <FolderDot color={folder.color} />
                <span className="truncate">{folder.name}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
