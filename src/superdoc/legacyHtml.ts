import { generateHTML } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { ListItem } from "@tiptap/extension-list";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { LineHeight } from "@/components/extensions/line-height";
import { FontSize } from "@/components/extensions/font-size";
import { Indent } from "@/components/extensions/indent";
import type { LegacyPlan } from "./convertLegacy";

/** The TipTap schema Folio's documents were written in, minus the editing-only
 *  extensions — enough to render any stored block as HTML for SuperDoc. */
const EXTENSIONS = [
  StarterKit.configure({ listItem: false }),
  // Folio's list items can start with a heading (see DocEditor).
  ListItem.extend({ content: "(paragraph|heading) block*" }),
  TextAlign.configure({ types: ["heading", "paragraph"] }),
  TextStyle,
  Color,
  LineHeight,
  FontSize,
  Indent,
  Table,
  TableRow,
  TableHeader,
  TableCell,
];

export const legacyHtml = (plan: LegacyPlan): string =>
  generateHTML({ type: "doc", content: plan.blocks.map((b) => b.node) }, EXTENSIONS);
