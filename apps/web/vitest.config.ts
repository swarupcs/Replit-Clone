import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Needed to transform JSX in component tests.
  plugins: [react()],
  test: {
    // Most units here are plain TypeScript and need no DOM, so node stays the
    // default. A component test opts in with `// @vitest-environment jsdom`.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Stores that persist preferences reach for localStorage at import time.
    setupFiles: ["src/test/setup.ts"],
  },
});
