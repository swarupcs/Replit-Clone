import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import globalSetup from "../../e2e/global-setup.ts";

/** The gate that decides whether the E2E suite runs or stands down.
 *
 *  Worth testing precisely because of what it protects: the suite skips
 *  quietly when the dev stack is not up, which is the right default on a
 *  laptop and a disaster in a pipeline. A CI job that skipped all four specs
 *  would report a green tick meaning "the real stack was exercised" when
 *  nothing had been started at all — a false negative in the one place the
 *  project has no other safety net. `E2E_REQUIRE` is what makes that
 *  impossible, so it is the part that has to be right.
 */

const KEYS = [
  "E2E_REQUIRE",
  "E2E_SKIP",
  "E2E_SKIP_CONTAINERS",
  "E2E_BASE_URL",
  "E2E_API_URL",
] as const;

let saved: Record<string, string | undefined>;

/** Stands in for the web app and the API's /health. */
function stack(options: { web: boolean; database: boolean; docker: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown) => {
      const url = String(input);

      if (url.includes("/health")) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              checks: {
                database: { ok: options.database },
                docker: { ok: options.docker },
              },
            }),
        } as unknown as Response);
      }

      return options.web
        ? Promise.resolve({ ok: true } as Response)
        : Promise.reject(new Error("ECONNREFUSED"));
    }),
  );
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("when nobody is requiring the suite to run", () => {
  it("stands down quietly if the stack is not up", async () => {
    // The laptop case. Failing here would mean `pnpm test` could not pass on a
    // machine with no dev server running, which is most of them.
    stack({ web: false, database: false, docker: false });

    await expect(globalSetup()).resolves.toBeUndefined();
    expect(process.env["E2E_SKIP"]).toBe("1");
  });

  it("runs the flows that need no container when Docker is missing", async () => {
    stack({ web: true, database: true, docker: false });

    await globalSetup();

    expect(process.env["E2E_SKIP"]).toBeUndefined();
    expect(process.env["E2E_SKIP_CONTAINERS"]).toBe("1");
  });

  it("runs everything when the whole stack is up", async () => {
    stack({ web: true, database: true, docker: true });

    await globalSetup();

    expect(process.env["E2E_SKIP"]).toBeUndefined();
    expect(process.env["E2E_SKIP_CONTAINERS"]).toBeUndefined();
  });
});

describe("when E2E_REQUIRE is set", () => {
  beforeEach(() => {
    process.env["E2E_REQUIRE"] = "1";
  });

  it("fails rather than skipping when the stack is not up", async () => {
    // Thrown from global setup, so the run dies before a spec is collected.
    // Nothing about the result can be read as a pass.
    stack({ web: false, database: false, docker: false });

    await expect(globalSetup()).rejects.toThrow(/E2E_REQUIRE/);
  });

  it("fails when the web app is up but the database is not", async () => {
    stack({ web: true, database: false, docker: true });

    await expect(globalSetup()).rejects.toThrow(/not up/);
  });

  it("fails when there is no Docker daemon", async () => {
    // The subtler of the two. Here the suite would otherwise run, pass, and
    // report green having silently dropped every flow that starts a
    // container — which is every flow worth having an E2E suite for.
    stack({ web: true, database: true, docker: false });

    await expect(globalSetup()).rejects.toThrow(/Docker/);
  });

  it("says nothing and sets nothing when the stack is up", async () => {
    stack({ web: true, database: true, docker: true });

    await expect(globalSetup()).resolves.toBeUndefined();
    expect(process.env["E2E_SKIP"]).toBeUndefined();
    expect(process.env["E2E_SKIP_CONTAINERS"]).toBeUndefined();
  });
});
