import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Integration tests do real database work and lazily import the whole service
    // graph (Gmail client, BullMQ, the AI pipeline) on first use. The Vitest
    // default of 5s is not enough for the first test in the file, which pays the
    // cold-start cost for Prisma's engine, ioredis and module transformation.
    // Unit tests are unaffected — they finish in milliseconds.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/workers/index.ts", "src/index.ts"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
