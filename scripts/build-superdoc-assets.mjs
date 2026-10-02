// Builds the static assets SuperDoc loads by URL (so they live in public/,
// not in Next's bundle). Output is gitignored and rebuilt by `pnpm dev` /
// `pnpm build`.
//   - public/superdoc/collab-worker.js: SuperDoc's collaboration worker +
//     Folio's Convex provider adapter, bundled into one module worker.
//   - public/superdoc/fonts/*.woff2: the editor's fonts, copied from
//     assets/superdoc-fonts/ (the list lives in src/superdoc/fonts.ts).
//   - public/superdoc/folio-template.docx: the file new documents start from
//     (scripts/folio-docx-template.mjs).
import { build } from "esbuild";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildFolioTemplate } from "./folio-docx-template.mjs";

await build({
  entryPoints: ["src/superdoc/collab-worker.ts"],
  outfile: "public/superdoc/collab-worker.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  logLevel: "warning",
});

// Load the font list from the app's own module so the two can't drift.
const fontsModule = await build({
  entryPoints: ["src/superdoc/fonts.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "warning",
});
const { SUPERDOC_FONTS, DEFAULT_SUPERDOC_FONT, fontFiles } = await import(
  "data:text/javascript;base64," + Buffer.from(fontsModule.outputFiles[0].text).toString("base64")
);

const outDir = "public/superdoc/fonts";
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
for (const font of SUPERDOC_FONTS) {
  for (const file of fontFiles(font)) {
    await copyFile(path.join("assets/superdoc-fonts", file), path.join(outDir, file));
  }
}

await writeFile(
  "public/superdoc/folio-template.docx",
  await buildFolioTemplate(DEFAULT_SUPERDOC_FONT),
);
