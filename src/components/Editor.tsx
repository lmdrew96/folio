"use client";

import { useEffect, useRef } from "react";
import { useEditor, EditorContent, type JSONContent } from "@tiptap/react";
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

export function Editor({ documentId }: { documentId: Id<"documents"> }) {
  const blocks = useQuery(api.blocks.list, { documentId });
  const replaceAll = useMutation(api.blocks.replaceAll);
  // Load DB content into the editor exactly once; after that the editor is the
  // source of truth (live external sync is Patch 2's job, not Patch 1's).
  const loadedRef = useRef(false);

  const editor = useEditor({
    immediatelyRender: false, // required for Next.js SSR (TipTap v3)
    extensions: [StarterKit, UniqueID.configure({ types: BLOCK_TYPES })],
    editorProps: {
      attributes: {
        class:
          "prose prose-neutral dark:prose-invert max-w-none min-h-[60vh] focus:outline-none",
      },
    },
    onBlur: ({ editor }) => {
      // Naive Patch 1 save: snapshot top-level nodes and full-replace.
      const top = (editor.getJSON().content ?? []) as JSONContent[];
      const payload = top
        .filter((node) => typeof node.attrs?.id === "string")
        .map((node, index) => ({
          blockId: node.attrs!.id as string,
          type: node.type ?? "paragraph",
          content: node,
          order: index,
        }));
      void replaceAll({ documentId, blocks: payload });
    },
  });

  useEffect(() => {
    if (!editor || loadedRef.current || blocks === undefined) return;
    loadedRef.current = true;
    if (blocks.length > 0) {
      editor.commands.setContent({
        type: "doc",
        content: blocks.map((b) => b.content as JSONContent),
      });
    }
  }, [editor, blocks]);

  if (!editor) return null;

  return <EditorContent editor={editor} />;
}
