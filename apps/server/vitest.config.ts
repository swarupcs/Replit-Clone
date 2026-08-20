import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // `config/env.ts` validates on import and calls process.exit when it fails,
    // so the environment has to be in place before any module under test loads.
    setupFiles: ["src/test/setupEnv.ts"],
  },
});
