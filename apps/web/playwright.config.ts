import { defineConfig } from "@playwright/test";

/** End-to-end tests drive the REAL stack: web, API, Postgres, Docker, and a
 *  project container with a dev server in it. Nothing is mocked, because the
 *  point is to catch the seams — the ones every recent bug lived in: a save
 *  reaching the container, a run the socket agreed about, a preview that
 *  actually renders.
 *
 *  The stack is not started by Playwright. It is the developer's own
 *  `pnpm dev` (or a deployed environment), and when it is not reachable the
 *  whole suite skips rather than fails — the same deal the DB-backed server
 *  tests make with TEST_DATABASE_URL.
 */
export default defineConfig({
  testDir: "./e2e",
  // One real container per project, and Docker on a laptop does not parallelise
  // kindly. The flows are long but there are few of them.
  timeout: 180_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env["E2E_BASE_URL"] ?? "http://localhost:15273",
    // Real containers take real time to boot.
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
  },
  outputDir: "./e2e/.artifacts",
  globalSetup: "./e2e/global-setup.ts",
});
