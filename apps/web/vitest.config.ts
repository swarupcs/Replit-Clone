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
    // The backend origin the app builds socket URLs from.
    //
    // `useLanguageServer`'s `socketUrl` does `new URL(import.meta.env
    // .VITE_BACKEND_URL)`, which throws `Invalid URL: undefined` when it is
    // unset -- taking nine tests with it. That is not a defect in those tests:
    // a unit suite should not need an environment file to run, and needing one
    // is how this came to fail in two places at once. It failed in CI, because
    // only the `e2e` job sets VITE_BACKEND_URL while `pnpm -r test` runs under
    // `verify`; and it failed on any fresh clone, because `apps/web/.env` is
    // gitignored -- so the suite passed only for people who had copied
    // `.env.example`, which is exactly the set who would never notice.
    //
    // Here rather than in `setup.ts` because `import.meta.env` is typed
    // read-only, and `test.env` is the seam vitest provides for precisely
    // this. A real value in the environment still wins.
    env: { VITE_BACKEND_URL: "http://localhost:3000" },
  },
});
