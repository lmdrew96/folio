#!/usr/bin/env node
// Snapshots recent commit history into a static JSON file so the in-app
// change log (ChangeLog.tsx) never needs runtime `git` access — Vercel's
// deployed functions don't reliably carry the repo's .git history. Re-run
// (`pnpm changelog`) and commit the result before shipping a release.
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_PATH = fileURLToPath(new URL("../src/generated/changelog.json", import.meta.url));
const COUNT = 10;
const FIELD_SEP = "\x1f"; // unit separator — won't collide with commit text

const raw = execSync(
  `git log -n ${COUNT} --pretty=format:%H${FIELD_SEP}%ad${FIELD_SEP}%s --date=short`,
  { encoding: "utf8", cwd: fileURLToPath(new URL("..", import.meta.url)) },
);

const entries = raw
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [hash, date, subject] = line.split(FIELD_SEP);
    return { hash: hash.slice(0, 7), date, subject };
  });

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(entries, null, 2)}\n`);
console.log(`Wrote ${entries.length} entries to ${OUT_PATH}`);
