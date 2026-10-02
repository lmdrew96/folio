/**
 * Fonts offered in the SuperDoc editor.
 *
 * SuperDoc lays text out in a worker, so it can't see the fonts the page
 * loads through next/font — each family is registered with SuperDoc from
 * self-hosted woff2 files (copied out of @fontsource-variable/* into
 * public/superdoc/fonts/ by scripts/build-superdoc-assets.mjs).
 *
 * Each family ships as two subsets: "latin" (ASCII + Western European) and
 * "latin-ext" (ă, ș, ț and the rest of Central/Eastern European). Both are
 * registered with the subset's unicode-range so a document in Romanian
 * renders in the chosen face instead of falling back per character.
 */

export type SuperDocFont = {
  /** Family name as stored in the DOCX and shown in the font menu. */
  family: string;
  /** @fontsource-variable package slug (and file-name prefix). */
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

// From @fontsource-variable's own CSS — the two subsets Folio serves.
const SUBSETS = {
  latin:
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  "latin-ext":
    "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
} as const;

/** Every woff2 file the build copies — shared with the build script. */
export function fontFiles(font: SuperDocFont): string[] {
  const styles = font.italic ? ["normal", "italic"] : ["normal"];
  return Object.keys(SUBSETS).flatMap((subset) =>
    styles.map((style) => `${font.slug}-${subset}-wght-${style}.woff2`),
  );
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
      faces: Object.entries(SUBSETS).flatMap(([subset, unicodeRange]) =>
        (font.italic ? (["normal", "italic"] as const) : (["normal"] as const)).flatMap((style) =>
          [400, 700].map((weight) => ({
            source: `${SUPERDOC_FONT_DIR}/${font.slug}-${subset}-wght-${style}.woff2`,
            weight,
            style,
            unicodeRange,
          })),
        ),
      ),
    })),
  };
}

/** The toolbar's font menu — it owns the list, so it names every choice. */
export const SUPERDOC_FONT_OPTIONS = [
  ...SUPERDOC_FONTS.map((f) => ({ value: f.family, label: f.family, previewFamily: f.family })),
  ...SYSTEM_FONTS.map((f) => ({ value: f, label: f, previewFamily: f })),
];
