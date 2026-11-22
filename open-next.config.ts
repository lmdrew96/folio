import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incrementalCache: Folio has no ISR (no revalidate, generateStaticParams
// or unstable_cache), so an R2 bucket here would cache nothing.
// OpenNext runs `pnpm build` (plain next build) itself; Workers Builds calls
// `pnpm cf:build`. `build` stays plain Next so Vercel keeps deploying until
// cutover.
export default defineCloudflareConfig();
