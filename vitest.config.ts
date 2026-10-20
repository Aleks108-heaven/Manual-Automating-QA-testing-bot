import { defineConfig } from "vitest/config";

// CI tests are deterministic: they use the scripted fake model and the local fixture site.
// Live-model scenarios belong to tests/eval and are not run here.
export default defineConfig({
  test: {
    include: ["tests/ci/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
