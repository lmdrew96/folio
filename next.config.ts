import type { NextConfig } from "next";
import { readFileSync } from "node:fs";

// The running build's identity, inlined into both the client bundle and the
// /api/version route handler. An open tab compares its own baked-in value
// against whatever the live deployment reports and offers a refresh when they
// diverge (see lib/useAppVersion.ts). Vercel's commit SHA is the honest answer
// when it's there; the package version covers a local production build.
const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version?: string;
};
const APP_VERSION =
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? pkg.version ?? "dev";

const nextConfig: NextConfig = {
  reactCompiler: true,
  env: { NEXT_PUBLIC_APP_VERSION: APP_VERSION },
};

export default nextConfig;
