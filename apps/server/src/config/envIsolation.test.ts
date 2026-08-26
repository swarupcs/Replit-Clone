import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** A test run must not depend on whatever is in a developer's own `.env`.
 *
 *  `config/env.ts` calls `dotenv.config()`, and dotenv fills only variables
 *  that are UNSET — so before this guard, a `.env` shadowed the deliberate
 *  environment `test/setupEnv.ts` puts in place. Setting
 *  `AUTO_START_ON_OPEN=false`, which `.env.example` recommends for a small VM,
 *  failed six auto-start tests on that machine and passed everywhere else.
 *
 *  Asserted by reading the source rather than by importing it: the module has
 *  already loaded by the time any test runs, so its effect cannot be observed
 *  after the fact.
 */
describe("the test environment", () => {
  it("does not load the developer's .env", () => {
    const source = readFileSync(
      new URL("./env.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain('process.env["NODE_ENV"] !== "test"');
    // And the call is not made unconditionally somewhere else in the file.
    expect(source).not.toMatch(/^dotenv\.config\(\);$/m);
  });

  it("runs as NODE_ENV=test, which is what that guard keys on", () => {
    expect(process.env["NODE_ENV"]).toBe("test");
  });
});
