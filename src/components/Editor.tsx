"use client";

import { useEffect, useRef } from "react";
import {
  useEditor,
  EditorContent,
  type Editor as TiptapEditor,
  type JSONContent,
} from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { UniqueID } from "@tiptap/extension-unique-id";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

// Top-level block node types that get a stable UniqueID (and thus a Convex row).
const BLOCK_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "bulletList",
  "orderedList",
  "horizontalRule",
];

const DEBOUNCE_MS = 600;

type DesiredBlock = { blockId: string; type: string; content: JSONContent };

/**
 * Snapshot the editor's top-level nodes into the reconcile payload.
 * Returns null if a duplicate id is present — that means UniqueID hasn't yet
 * reassigned a fresh id after a split/paste, so we skip this flush rather than
 * collide two rows on the same blockId (the spec's "most likely 1am bug").
 * Nodes still missing an id are dropped; the next flush picks them up.
 */
function buildDesired(editor: TiptapEditor): DesiredBlock[] | null {
  const top = (editor.getJSON().content ?? []) as JSONContent[];
  const desired: DesiredBlock[] = [];
  const seen = new Set<string>();
  for (const node of top) {
    const id = node.attrs?.id;
    if (typeof id !== "string") continue;
    if (seen.has(id)) return null;
    seen.add(id);
    desired.push({ blockId: id, type: node.type ?? "paragraph", content: node });
  }
  return desired;
}

export function Editor({ documentId }: { documentId: Id<"documents"> }) {
  const blocks = useQuery(api.blocks.list, { documentId });
  const reconcile = useMutation(api.blocks.reconcile);

  const loadedRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Hash of the last desired-state we successfully synced; lets us skip
  // reconcile calls that wouldn't change anything.
  const lastSyncedHashRef = useRef<string | null>(null);

  const flush = (editor: TiptapEditor) => {
    const desired = buildDesired(editor);
    if (desired === null) return; // duplicate ids — let UniqueID settle
    const hash = JSON.stringify(desired);
    if (hash === lastSyncedHashRef.current) return; // nothing changed
    void reconcile({ documentId, blocks: desired })
      .then(() => {
        lastSyncedHashRef.current = hash;
      })
      .catch((e) => {
        console.error("Folio: block reconcile failed", e);
      });
  };

  const editor = useEditor({
    immediatelyRender: false, // required for Next.js SSR (TipTap v3)
    extensions: [StarterKit, UniqueID.configure({ types: BLOCK_TYPES })],
    editorProps: {
      attributes: {
        class:
          "prose prose-neutral dark:prose-invert max-w-none min-h-[60vh] focus:outline-none",
      },
    },
    onUpdate: ({ editor }) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => flush(editor), DEBOUNCE_MS);
    },
    onBlur: ({ editor }) => {
      // Save promptly when leaving the editor — flush the pending debounce now.
      if (debounceRef.current) clearTimeout(debounceRef.current);
      flush(editor);
    },
  });

  // Load DB content once. setContent is silent (emitUpdate:false) and we then
  // record the synced hash, so the load never triggers a redundant reconcile.
  useEffect(() => {
    if (!editor || loadedRef.current || blocks === undefined) return;
    loadedRef.current = true;
    if (blocks.length > 0) {
      editor.commands.setContent(
        { type: "doc", content: blocks.map((b) => b.content as JSONContent) },
        { emitUpdate: false },
      );
    }
    const desired = buildDesired(editor);
    lastSyncedHashRef.current = desired ? JSON.stringify(desired) : null;
  }, [editor, blocks]);

  // Flush any pending debounce on unmount so the last edit isn't lost.
  useEffect(() => {
    const editorRef = editor;
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        if (editorRef) flush(editorRef);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  if (!editor) return null;

  return <EditorContent editor={editor} />;
}
