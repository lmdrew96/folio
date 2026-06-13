"use client";

import { useEffect, useRef, useState } from "react";
import {
  useEditor,
  EditorContent,
  type Editor as TiptapEditor,
  type JSONContent,
} from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { UniqueID } from "@tiptap/extension-unique-id";
import { TextAlign } from "@tiptap/extension-text-align";
import { Highlight } from "@tiptap/extension-highlight";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  Attribution,
  attributionPluginKey,
  type AttrInfo,
} from "./extensions/attribution";
import { SmartTypography } from "./extensions/typography";
import { Toolbar } from "./Toolbar";

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

// v0 has a single human author; Patch 5's AI path writes blocks as "claude".
const ACTOR = "nae";

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

export function DocEditor({ documentId }: { documentId: Id<"documents"> }) {
  const blocks = useQuery(api.blocks.list, { documentId });
  const reconcile = useMutation(api.blocks.reconcile);

  const loadedRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Hash of the last desired-state we successfully synced; lets us skip
  // reconcile calls that wouldn't change anything.
  const lastSyncedHashRef = useRef<string | null>(null);
  // Transient "Saved" confirmation for the explicit Ctrl/Cmd+S save.
  const savedHideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">(
    "idle",
  );

  const flush = (editor: TiptapEditor) => {
    const desired = buildDesired(editor);
    if (desired === null) return; // duplicate ids — let UniqueID settle
    const hash = JSON.stringify(desired);
    if (hash === lastSyncedHashRef.current) return; // nothing changed
    void reconcile({ documentId, actor: ACTOR, blocks: desired })
      .then(() => {
        lastSyncedHashRef.current = hash;
      })
      .catch((e) => {
        console.error("Folio: block reconcile failed", e);
      });
  };

  // Explicit save (Ctrl/Cmd+S). Folio already autosaves, so this mostly exists
  // to reassure — it flushes any pending edit now and flashes "Saved".
  const saveNow = async (editor: TiptapEditor) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const desired = buildDesired(editor);
    if (desired === null) return; // ids still settling — skip this beat
    const hash = JSON.stringify(desired);
    if (hash !== lastSyncedHashRef.current) {
      setSaveStatus("saving");
      try {
        await reconcile({ documentId, actor: ACTOR, blocks: desired });
        lastSyncedHashRef.current = hash;
      } catch (e) {
        console.error("Folio: manual save failed", e);
        setSaveStatus("idle");
        return;
      }
    }
    setSaveStatus("saved");
    if (savedHideRef.current) clearTimeout(savedHideRef.current);
    savedHideRef.current = setTimeout(() => setSaveStatus("idle"), 1600);
  };

  const editor = useEditor({
    immediatelyRender: false, // required for Next.js SSR (TipTap v3)
    extensions: [
      StarterKit.configure({
        // Link ships with StarterKit v3; don't follow links while editing.
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: "https",
        },
      }),
      UniqueID.configure({ types: BLOCK_TYPES }),
      Attribution,
      SmartTypography,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Highlight.configure({ multicolor: true }),
      TextStyle,
      Color,
    ],
    editorProps: {
      attributes: {
        // prose-lg = longform reading size; the default 65ch measure (no
        // max-w-none) + mx-auto centers the column as a page in calm space.
        // The attribution tick lives in the left margin now, so no pl gutter.
        class: "prose prose-lg mx-auto min-h-[60vh] focus:outline-none",
      },
      // Ctrl/Cmd+click opens a link in a new tab; a plain click just places the
      // cursor to edit it (Link is configured with openOnClick: false).
      handleClick(_view, _pos, event) {
        if (!(event.metaKey || event.ctrlKey)) return false;
        const href = (event.target as HTMLElement | null)
          ?.closest("a")
          ?.getAttribute("href");
        if (!href) return false;
        window.open(href, "_blank", "noopener,noreferrer");
        return true;
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

  // Push live attribution (author + lastEditedAt per block) into the editor so
  // the gutter decorations reflect persisted state. Meta-only transaction —
  // no doc change, so it never triggers a reconcile.
  useEffect(() => {
    if (!editor || blocks === undefined) return;
    const map = new Map<string, AttrInfo>();
    for (const b of blocks) {
      map.set(b.blockId, { author: b.author, lastEditedAt: b.lastEditedAt });
    }
    editor.view.dispatch(editor.state.tr.setMeta(attributionPluginKey, map));
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

  // Ctrl/Cmd+S → save now (and swallow the browser's save-page dialog).
  useEffect(() => {
    if (!editor) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "s" || e.key === "S")
      ) {
        e.preventDefault();
        void saveNow(editor);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Clear the "Saved" hide timer if we unmount mid-flash.
  useEffect(
    () => () => {
      if (savedHideRef.current) clearTimeout(savedHideRef.current);
    },
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {editor ? (
        <Toolbar editor={editor} />
      ) : (
        <div className="h-11 shrink-0 border-b border-foreground/10 bg-[var(--folio-backdrop)]" />
      )}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
          <div className="folio-paper">
            {editor ? (
              <EditorContent editor={editor} />
            ) : (
              <div className="min-h-[60vh]" />
            )}
          </div>
        </div>
      </div>
      <div
        aria-live="polite"
        className={`pointer-events-none fixed bottom-5 left-1/2 z-20 -translate-x-1/2 rounded-full border border-[var(--folio-paper-edge)] bg-[var(--folio-paper)] px-3 py-1 text-xs text-foreground/60 shadow-sm transition-opacity duration-200 ${
          saveStatus === "idle" ? "opacity-0" : "opacity-100"
        }`}
      >
        {saveStatus === "saving" ? "Saving…" : "Saved"}
      </div>
    </div>
  );
}
