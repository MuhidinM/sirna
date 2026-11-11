import { defineConfig } from "vitest/config";

/** `pnpm eval:ai`: the live AI evals, kept out of `pnpm test` (plan §7.6). */
export default defineConfig({
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    testTimeout: 20 * 60 * 1000,
  },
});
