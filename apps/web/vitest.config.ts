import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The units worth covering here — the fuzzy matcher and the tab reducers —
    // are plain TypeScript, so there is no reason to pay for a DOM.
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Stores that persist preferences reach for localStorage at import time.
    setupFiles: ["src/test/setup.ts"],
  },
});
