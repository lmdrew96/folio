import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Convex function tests opt into the edge-runtime environment per file
    // (`// @vitest-environment edge-runtime`), matching the Convex runtime.
    environment: "node",
    server: { deps: { inline: ["convex-test"] } },
  },
});
