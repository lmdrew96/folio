"use client";

import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { folderColorVar, subtreeIds, type Folder } from "@/lib/folders";

/**
 * Drag-and-drop filing on the desk — a shortcut for the card and folder
 * menus, never the only path (touch browsers don't fire HTML5 drag events).
 *
 * The dragged item travels in `dataTransfer` under Folio's own MIME types,
 * so stray drags (selected text, files from the OS) are ignored. dragover
 * can't read `dataTransfer` data, only its types, so the item is also kept
 * here for the length of the drag — that's what lets a target refuse a
 * folder dropped into its own subtree while the pointer is still over it.
 */
export type Dragged =
  | { kind: "doc"; id: Id<"documents">; folderId: Id<"folders"> | null }
  | { kind: "folder"; id: Id<"folders">; parentId: Id<"folders"> | null };

const MIME = { doc: "application/x-folio-doc", folder: "application/x-folio-folder" } as const;

let current: Dragged | null = null;

/** Props that make an element a drag source for `item`. */
export function dragSource(item: Dragged) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      current = item;
      e.dataTransfer.setData(MIME[item.kind], item.id);
      e.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: () => {
      current = null;
    },
  };
}

const isOurs = (e: DragEvent) =>
  current !== null && e.dataTransfer.types.includes(MIME[current.kind]);

/**
 * A drop target. `accept` decides whether the dragged item can land here
 * (a no-op move counts as no); `onDrop` performs the move. Spread `props`
 * onto the element and use `style` for its highlight: a tint and ring in
 * `color` (a folder color key) when droppable, dimmed when not.
 */
export function useDropTarget(
  accept: (item: Dragged) => boolean,
  onDrop: (item: Dragged) => void,
  color?: string,
) {
  const [state, setState] = useState<"idle" | "ok" | "no">("idle");
  // dragenter/dragleave fire for every child crossed — count to know when
  // the pointer has really left.
  const depth = useRef(0);

  // A drag that ends elsewhere (Escape, a drop on another target) can skip
  // this element's dragleave; reset on any drag end.
  useEffect(() => {
    if (state === "idle") return;
    const reset = () => {
      depth.current = 0;
      setState("idle");
    };
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, [state]);

  const props = {
    onDragEnter: (e: DragEvent) => {
      if (!isOurs(e)) return;
      depth.current++;
      setState(accept(current!) ? "ok" : "no");
    },
    onDragOver: (e: DragEvent) => {
      if (!isOurs(e)) return;
      if (accept(current!)) {
        e.preventDefault(); // marks this element as a valid drop target
        e.dataTransfer.dropEffect = "move";
      } else {
        e.dataTransfer.dropEffect = "none";
      }
    },
    onDragLeave: (e: DragEvent) => {
      if (!isOurs(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setState("idle");
    },
    onDrop: (e: DragEvent) => {
      if (!isOurs(e)) return;
      e.preventDefault();
      depth.current = 0;
      setState("idle");
      const item = current!;
      current = null;
      if (accept(item)) onDrop(item);
    },
  };

  const ring = folderColorVar(color);
  const style: CSSProperties | undefined =
    state === "ok"
      ? {
          boxShadow: `inset 0 0 0 2px ${ring}`,
          background: `color-mix(in srgb, ${ring} 14%, transparent)`,
        }
      : state === "no"
        ? { opacity: 0.45 }
        : undefined;

  return { props, style };
}

/** Whether `item` can be filed into `target` (null = Unfiled for a document,
 *  top level for a folder). A move to where it already is counts as no, and
 *  a folder can't go into itself or anything beneath it — the server
 *  rejects that too; this is what shows it as not droppable. */
export function canFile(
  item: Dragged,
  target: Id<"folders"> | null,
  tree: Map<Id<"folders"> | null, Folder[]>,
): boolean {
  if (item.kind === "doc") return item.folderId !== target;
  if (item.parentId === target) return false;
  return target === null || !subtreeIds(tree, item.id).has(target);
}

/** Files a dropped item: `moveToFolder` for a document, `move` for a folder.
 *  Neither bumps a document's updatedAt, so "last edited" order holds. */
export function useFile() {
  const moveDoc = useMutation(api.documents.moveToFolder);
  const moveFolder = useMutation(api.folders.move);
  return (item: Dragged, target: Id<"folders"> | null) => {
    const done =
      item.kind === "doc"
        ? moveDoc({ documentId: item.id, folderId: target })
        : moveFolder({ folderId: item.id, parentId: target });
    done.catch((e: unknown) => console.error("Folio: couldn't file that", e));
  };
}

/** A drop target that files into `target`: a folder (null = Unfiled for
 *  documents / top level for folders). `only` limits it to one kind. */
export function useFilingDrop(
  target: Id<"folders"> | null,
  tree: Map<Id<"folders"> | null, Folder[]>,
  { color, only }: { color?: string; only?: Dragged["kind"] } = {},
) {
  const file = useFile();
  return useDropTarget(
    (item) => (!only || item.kind === only) && canFile(item, target, tree),
    (item) => file(item, target),
    color,
  );
}
