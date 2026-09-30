// Bundles SuperDoc's collaboration worker + Folio's Convex provider adapter
// into one module-worker file. SuperDoc spawns it from a URL
// (workerUrls.collaboration), so it's a static asset, not part of Next's
// bundle. Output is gitignored and rebuilt by `pnpm dev` / `pnpm build`.
import { build } from "esbuild";

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
