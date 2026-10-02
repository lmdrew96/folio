/**
 * Fonts offered in the SuperDoc editor.
 *
 * SuperDoc lays text out in a worker, so it can't see the fonts the page
 * loads through next/font — each family is registered with SuperDoc from
 * self-hosted woff2 files. Those live in assets/superdoc-fonts/ (committed;
 * produced by scripts/fetch-superdoc-fonts.py from the google/fonts repo) and
 * are copied to public/superdoc/fonts/ by scripts/build-superdoc-assets.mjs.
 *
 * One file per style, covering Latin + Latin Extended (so Romanian ă ș ț
 * render in the chosen face): SuperDoc registers exactly one face per
 * family/weight/style and rejects a second source for the same face, so
 * split unicode-range subsets don't work here.
 */

export type SuperDocFont = {
  /** Family name as stored in the DOCX and shown in the font menu. */
  family: string;
  /** File-name prefix in assets/superdoc-fonts/. */
  slug: string;
  italic: boolean;
};

export const SUPERDOC_FONTS: SuperDocFont[] = [
  { family: "Fraunces", slug: "fraunces", italic: true },
  { family: "Newsreader", slug: "newsreader", italic: true },
  { family: "Lora", slug: "lora", italic: true },
  { family: "Source Serif 4", slug: "source-serif-4", italic: true },
  { family: "Quicksand", slug: "quicksand", italic: false },
  { family: "Space Grotesk", slug: "space-grotesk", italic: false },
  { family: "Inter", slug: "inter", italic: true },
  { family: "Work Sans", slug: "work-sans", italic: true },
  { family: "Manrope", slug: "manrope", italic: false },
  { family: "Geist Mono", slug: "geist-mono", italic: true },
  { family: "JetBrains Mono", slug: "jetbrains-mono", italic: true },
];

/** System fonts kept in the menu for documents that came from Word. */
const SYSTEM_FONTS = ["Arial", "Times New Roman"];

/** Font for new SuperDoc documents — Folio's longstanding prose default. */
export const DEFAULT_SUPERDOC_FONT = "Fraunces";

export const SUPERDOC_FONT_DIR = "/superdoc/fonts";

const styles = (font: SuperDocFont) =>
  font.italic ? (["normal", "italic"] as const) : (["normal"] as const);

/** Every woff2 file the build copies — shared with the build script. */
export function fontFiles(font: SuperDocFont): string[] {
  return styles(font).map((style) => `${font.slug}-${style}.woff2`);
}

/**
 * SuperDoc `fonts` config. The files are variable fonts, so one file serves
 * every weight — but SuperDoc wants each weight/style registered, so regular
 * and bold (and their italics) each point at the same file.
 */
export function superDocFontsConfig() {
  return {
    families: SUPERDOC_FONTS.map((font) => ({
      family: font.family,
      faces: styles(font).flatMap((style) =>
        [400, 700].map((weight) => ({
          source: `${SUPERDOC_FONT_DIR}/${font.slug}-${style}.woff2`,
          weight,
          style,
        })),
      ),
    })),
  };
}

/** The toolbar's font menu — it owns the list, so it names every choice. */
export const SUPERDOC_FONT_OPTIONS = [
  ...SUPERDOC_FONTS.map((f) => ({ value: f.family, label: f.family, previewFamily: f.family })),
  ...SYSTEM_FONTS.map((f) => ({ value: f, label: f, previewFamily: f })),
];
