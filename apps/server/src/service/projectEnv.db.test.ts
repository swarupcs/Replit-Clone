import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbScope } from "../test/dbScope.js";
import type { env as EnvConfig } from "../config/env.js";

/** What actually lands in the `envVars` column, and what a backfill does to
 *  what is already there.
 *
 *  Against real rows, because the claim being made is about the DATABASE — "a
 *  dump of this table is not a list of everybody's live credentials" — and
 *  that claim cannot be checked by asserting on a value a mock handed back. It
 *  is checked by reading the column.
 *
 *  Set TEST_DATABASE_URL to a throwaway Postgres with the migrations applied.
 */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe.skipIf(!TEST_DATABASE_URL)("environment variables at rest", () => {
  const scope = dbScope("project-env");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let envService: typeof import("./projectEnvService.js");

  /** Imported in `beforeAll`, NOT at the top of the file.
   *
   *  `config/env.ts` parses `process.env` once, on first import, and
   *  `setupEnv.ts` seeds a dummy `DATABASE_URL` so that importing it never
   *  fails. Importing it up here would freeze that dummy before `beforeAll`
   *  could put the real URL in place, and every query in the suite would
   *  authenticate as `test` against a database that has no such user. Which is
   *  exactly what happened the first time this file was run. */
  let env: typeof EnvConfig;
  let originalKey: string | undefined;
  const KEY = Buffer.alloc(32, 5).toString("base64");

  let ownerId: string;
  let projectId: string;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ env } = await import("../config/env.js"));
    originalKey = env.SECRET_ENCRYPTION_KEY;
    ({ prisma } = await import("../lib/prisma.js"));
    envService = await import("./projectEnvService.js");
  });

  beforeEach(async () => {
    env.SECRET_ENCRYPTION_KEY = KEY;

    const owner = await prisma.user.create({
      data: { email: scope.email("owner"), passwordHash: "x" },
    });
    ownerId = owner.id;

    const project = await prisma.project.create({
      data: { name: "Site", ownerId, template: "static-html" },
    });
    projectId = project.id;
  });

  afterEach(async () => {
    env.SECRET_ENCRYPTION_KEY = originalKey;
    await scope.cleanup(prisma);
  });

  /** The column exactly as stored, with nothing opened on the way out. */
  async function stored(id = projectId): Promise<Record<string, unknown>> {
    const row = await prisma.project.findUniqueOrThrow({
      where: { id },
      select: { envVars: true },
    });
    return row.envVars as Record<string, unknown>;
  }

  describe("writing", () => {
    it("does not put the secret in the column", async () => {
      await envService.setEnvVars(projectId, { STRIPE_KEY: "sk_live_hunter2" });

      // The whole point of the change, stated against the database.
      expect(JSON.stringify(await stored())).not.toContain("sk_live_hunter2");
    });

    it("leaves the name readable", async () => {
      // The name is not the secret, and an operator debugging a container has
      // to be able to see which variables exist.
      await envService.setEnvVars(projectId, { STRIPE_KEY: "sk_live_hunter2" });

      expect(Object.keys(await stored())).toEqual(["STRIPE_KEY"]);
    });

    it("round-trips through the reader", async () => {
      await envService.setEnvVars(projectId, {
        STRIPE_KEY: "sk_live_hunter2",
        API_URL: "https://example.com",
      });

      expect(await envService.getEnvVars(projectId)).toMatchObject({
        STRIPE_KEY: "sk_live_hunter2",
        API_URL: "https://example.com",
      });
    });

    it("seals each value on its own, so two equal values differ in the column", async () => {
      // A distinct IV per value. Identical ciphertext for identical plaintext
      // would leak which projects share a key without opening anything.
      await envService.setEnvVars(projectId, { A: "same", B: "same" });

      const row = await stored();
      expect(row["A"]).not.toBe(row["B"]);
    });

    it("returns what the caller sent rather than a re-read", async () => {
      const saved = await envService.setEnvVars(projectId, { A: "1" });
      expect(saved).toEqual({ A: "1" });
    });

    it("stores plain text, and says it is not encrypted, with no key", async () => {
      // An install that never set a key keeps working rather than losing a
      // core feature -- but it must not claim a protection it does not have.
      delete env.SECRET_ENCRYPTION_KEY;

      await envService.setEnvVars(projectId, { A: "plain" });

      expect(envService.envVarsEncryptedAtRest()).toBe(false);
      expect(await stored()).toEqual({ A: "plain" });
      expect(await envService.getEnvVars(projectId)).toMatchObject({ A: "plain" });
    });
  });

  describe("the backfill", () => {
    /** A row as it looked before any of this existed. */
    async function writePlaintext(vars: Record<string, string>): Promise<void> {
      await prisma.project.update({
        where: { id: projectId },
        data: { envVars: vars },
      });
    }

    it("seals what was already in the clear", async () => {
      await writePlaintext({ STRIPE_KEY: "sk_live_hunter2" });

      // Aimed at this project. Unaimed it sweeps every row in the database,
      // which against a shared test database means sealing other suites' rows
      // under a key only this worker has -- they then fail somewhere else
      // entirely, which is a long way to walk back from.
      expect(await envService.backfillSealedEnvVars([projectId])).toMatchObject({
        sealed: 1,
      });
      expect(JSON.stringify(await stored())).not.toContain("sk_live_hunter2");
      expect(await envService.getEnvVars(projectId)).toMatchObject({
        STRIPE_KEY: "sk_live_hunter2",
      });
    });

    it("is idempotent", async () => {
      await writePlaintext({ A: "1" });
      await envService.backfillSealedEnvVars([projectId]);
      const afterFirst = await stored();

      // Nothing left to do, and in particular nothing double-sealed: a second
      // pass that re-sealed would make the value unreadable in one step.
      expect(await envService.backfillSealedEnvVars([projectId])).toMatchObject({
        sealed: 0,
      });
      expect(await stored()).toEqual(afterFirst);
      expect(await envService.getEnvVars(projectId)).toMatchObject({ A: "1" });
    });

    it("touches only the plaintext half of a mixed row", async () => {
      // What an interrupted backfill leaves behind.
      const { seal } = await import("../lib/secretBox.js");
      await writePlaintext({ OLD: "plain", NEW: seal("already") });
      const before = (await stored())["NEW"];

      expect(await envService.backfillSealedEnvVars([projectId])).toMatchObject({
        sealed: 1,
      });

      expect((await stored())["NEW"]).toBe(before);
      expect(await envService.getEnvVars(projectId)).toMatchObject({
        OLD: "plain",
        NEW: "already",
      });
    });

    it("does nothing at all without a key", async () => {
      await writePlaintext({ A: "1" });
      delete env.SECRET_ENCRYPTION_KEY;

      // Sealing under no key is not possible, and pretending otherwise would
      // throw at boot on every server that has not set one.
      expect(await envService.backfillSealedEnvVars([projectId])).toMatchObject({ sealed: 0 });
      expect(await stored()).toEqual({ A: "1" });
    });

    it("leaves a project with no variables alone", async () => {
      expect(await envService.backfillSealedEnvVars([projectId])).toMatchObject({
        sealed: 0,
      });
      expect(await stored()).toEqual({});
    });
  });
});
