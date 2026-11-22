import type { NextConfig } from "next";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// The running build's identity, inlined into both the client bundle and the
// /api/version route handler. An open tab compares its own baked-in value
// against whatever the live deployment reports and offers a refresh when they
// diverge (see lib/useAppVersion.ts), so it must change on every deploy.
// Workers Builds exposes the commit as WORKERS_CI_COMMIT_SHA (Vercel, until
// it's removed, as VERCEL_GIT_COMMIT_SHA); git covers a local build; the package version is the last resort.
const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version?: string;
};
const gitSha = (): string | undefined => {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch (err) {
    console.warn("next.config: git rev-parse failed, using package version", err);
    return undefined;
  }
};
const APP_VERSION =
  process.env.WORKERS_CI_COMMIT_SHA?.slice(0, 7) ??
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
  gitSha() ??
  pkg.version ??
  "dev";

// Production PUBLIC values (they ship to the browser anyway). The Cloudflare
// build container has no .env file and its build variables don't reliably
// reach `next build`, so these are the fallback. Locally, .env.local is loaded
// first and its dev values win. Keep in sync with `vars` in wrangler.jsonc.
const PROD_PUBLIC = {
  NEXT_PUBLIC_CONVEX_URL: "https://utmost-jackal-339.convex.cloud",
  NEXT_PUBLIC_CONVEX_SITE_URL: "https://utmost-jackal-339.convex.site",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_Y2xlcmsuZm9saW8uYWRoZGVzaWducy5kZXYk",
};

const nextConfig: NextConfig = {
  reactCompiler: true,
  env: {
    NEXT_PUBLIC_APP_VERSION: APP_VERSION,
    NEXT_PUBLIC_CONVEX_URL:
      process.env.NEXT_PUBLIC_CONVEX_URL ?? PROD_PUBLIC.NEXT_PUBLIC_CONVEX_URL,
    NEXT_PUBLIC_CONVEX_SITE_URL:
      process.env.NEXT_PUBLIC_CONVEX_SITE_URL ??
      PROD_PUBLIC.NEXT_PUBLIC_CONVEX_SITE_URL,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??
      PROD_PUBLIC.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  },
};

export default nextConfig;
