import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      // The plugin's runtime imports of "obsidian" resolve to an inert stub
      // so that editor-action tests can run in plain Node.
      obsidian: path.resolve(__dirname, "test/obsidian-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
