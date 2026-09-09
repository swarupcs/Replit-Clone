import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  userPersonalization: { findUnique: vi.fn(), upsert: vi.fn() },
  project: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
}));
vi.mock("../lib/prisma.js", () => ({ prisma: prismaMock }));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Sealing is `projectEnvService`'s decision and is tested there. Stubbed to a
 *  recognisable shape so these tests can tell "stored sealed" from "stored in
 *  the clear" without asserting on cryptography. */
vi.mock("../lib/secretBox.js", () => ({
  isSecretBoxConfigured: () => true,
  looksSealed: (value: string) => value.startsWith("sealed:"),
  seal: (value: string) => `sealed:${value}`,
  open: (value: string) => value.slice("sealed:".length),
}));

const databaseEnv = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
vi.mock("./managedDatabaseService.js", () => ({ databaseEnv }));

import {
  getAccountSecrets,
  setAccountSecrets,
  shadowedNames,
} from "./accountSecretService.js";
import { getEnvVars } from "./projectEnvService.js";

const USER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

beforeEach(() => {
  vi.clearAllMocks();
  databaseEnv.mockResolvedValue({});
  prismaMock.userPersonalization.findUnique.mockResolvedValue(null);
  prismaMock.project.findUnique.mockResolvedValue({
    envVars: {},
    ownerId: USER,
  });
});

describe("an account's own variables", () => {
  it("is empty for an account that has never set one", () => {
    // Every account that existed before this column did, which is all of them.
    return expect(getAccountSecrets(USER)).resolves.toEqual({});
  });

  it("seals values on the way in", async () => {
    await setAccountSecrets(USER, { ANTHROPIC_API_KEY: "sk-live" });

    const call = prismaMock.userPersonalization.upsert.mock.calls[0]?.[0] as {
      create: { envVars: Record<string, string> };
    };

    // The same rule as `projects.envVars`, through the same function: names in
    // the clear so an operator can see which exist, values sealed one at a
    // time so one unreadable value costs one variable.
    expect(call.create.envVars).toEqual({ ANTHROPIC_API_KEY: "sealed:sk-live" });
  });

  it("opens them again on the way out", async () => {
    prismaMock.userPersonalization.findUnique.mockResolvedValue({
      envVars: { NPM_TOKEN: "sealed:npm_abc" },
    });

    await expect(getAccountSecrets(USER)).resolves.toEqual({ NPM_TOKEN: "npm_abc" });
  });

  it("creates the row on a first write", async () => {
    // An account with no dotfiles and no signing key has no row at all, and a
    // first secret is a perfectly ordinary reason for one to exist.
    await setAccountSecrets(USER, { A: "1" });

    const call = prismaMock.userPersonalization.upsert.mock.calls[0]?.[0] as {
      where: { userId: string };
      create: { userId: string };
    };
    expect(call.where.userId).toBe(USER);
    expect(call.create.userId).toBe(USER);
  });

  it("replaces the whole set rather than merging", async () => {
    prismaMock.userPersonalization.findUnique.mockResolvedValue({
      envVars: { OLD: "sealed:1" },
    });

    await setAccountSecrets(USER, { NEW: "2" });

    const call = prismaMock.userPersonalization.upsert.mock.calls[0]?.[0] as {
      update: { envVars: Record<string, string> };
    };

    // A patch has no way to express "delete this one", and deletion is the
    // operation somebody most needs to be certain of when it is a live key.
    expect(call.update.envVars).toEqual({ NEW: "sealed:2" });
  });

  it("refuses a name the shell could not export", async () => {
    await expect(setAccountSecrets(USER, { "not a name": "x" })).rejects.toThrow(
      /MY_VARIABLE/,
    );
  });

  it("refuses a name the platform sets itself", async () => {
    // Same reserved list as a project's: shadowing PATH or HOME from an
    // account would break every container the account has at once.
    await expect(setAccountSecrets(USER, { PATH: "/evil" })).rejects.toThrow(
      /set by the platform/,
    );
  });

  it("writes nothing when the set is rejected", async () => {
    await expect(setAccountSecrets(USER, { HOME: "/tmp" })).rejects.toThrow();
    expect(prismaMock.userPersonalization.upsert).not.toHaveBeenCalled();
  });
});

/** The only genuinely new decision in §13.8. Everything else — names, limits,
 *  sealing — is `projectEnvService`'s, reused rather than restated. */
describe("which value a container gets", () => {
  it("hands the account's value to a project that sets nothing", async () => {
    prismaMock.userPersonalization.findUnique.mockResolvedValue({
      envVars: { ANTHROPIC_API_KEY: "sealed:sk-account" },
    });

    await expect(getEnvVars(PROJECT)).resolves.toEqual({
      ANTHROPIC_API_KEY: "sk-account",
    });
  });

  it("lets the project's own value win", async () => {
    prismaMock.userPersonalization.findUnique.mockResolvedValue({
      envVars: { API_KEY: "sealed:account" },
    });
    prismaMock.project.findUnique.mockResolvedValue({
      envVars: { API_KEY: "sealed:project" },
      ownerId: USER,
    });

    // The more specific setting is the one somebody chose for this project.
    await expect(getEnvVars(PROJECT)).resolves.toEqual({ API_KEY: "project" });
  });

  it("lets a managed database's URL win over an account-wide one", async () => {
    prismaMock.userPersonalization.findUnique.mockResolvedValue({
      envVars: { DATABASE_URL: "sealed:postgres://account" },
    });
    databaseEnv.mockResolvedValue({ DATABASE_URL: "postgres://managed" });

    // Ordering by specificity: an account value is the least specific thing
    // anybody said, and a database provisioned FOR THIS PROJECT is not.
    await expect(getEnvVars(PROJECT)).resolves.toEqual({
      DATABASE_URL: "postgres://managed",
    });
  });

  it("still lets the project override a managed database", async () => {
    prismaMock.userPersonalization.findUnique.mockResolvedValue({
      envVars: { DATABASE_URL: "sealed:account" },
    });
    databaseEnv.mockResolvedValue({ DATABASE_URL: "managed" });
    prismaMock.project.findUnique.mockResolvedValue({
      envVars: { DATABASE_URL: "sealed:mine" },
      ownerId: USER,
    });

    // The behaviour that was already there, unchanged by adding a scope
    // underneath it.
    await expect(getEnvVars(PROJECT)).resolves.toEqual({ DATABASE_URL: "mine" });
  });

  it("merges both sets rather than choosing one", async () => {
    prismaMock.userPersonalization.findUnique.mockResolvedValue({
      envVars: { FROM_ACCOUNT: "sealed:a" },
    });
    prismaMock.project.findUnique.mockResolvedValue({
      envVars: { FROM_PROJECT: "sealed:p" },
      ownerId: USER,
    });

    await expect(getEnvVars(PROJECT)).resolves.toEqual({
      FROM_ACCOUNT: "a",
      FROM_PROJECT: "p",
    });
  });

  it("does not fail a project because the account lookup did", async () => {
    prismaMock.userPersonalization.findUnique.mockRejectedValue(
      new Error("database is down"),
    );
    prismaMock.project.findUnique.mockResolvedValue({
      envVars: { A: "sealed:1" },
      ownerId: USER,
    });

    // A project that opened yesterday must keep opening. Losing an account
    // variable is a missing value; refusing here is a container that will not
    // start, and `envSignature` reads this on every start.
    await expect(getEnvVars(PROJECT)).resolves.toEqual({ A: "1" });
  });

  it("asks for nothing when the project does not exist", async () => {
    prismaMock.project.findUnique.mockResolvedValue(null);

    await expect(getEnvVars(PROJECT)).resolves.toEqual({});
    expect(prismaMock.userPersonalization.findUnique).not.toHaveBeenCalled();
  });
});

describe("telling somebody a value is shadowed", () => {
  it("names the ones a project overrides", () => {
    expect(
      shadowedNames({ A: "1", B: "2", C: "3" }, { B: "x", C: "y", D: "z" }),
    ).toEqual(["B", "C"]);
  });

  it("is empty when nothing collides", () => {
    expect(shadowedNames({ A: "1" }, { B: "2" })).toEqual([]);
  });

  it("does not report a project-only name as shadowed", () => {
    // The panel is about the account's variables, so a name only the project
    // has is not this list's business.
    expect(shadowedNames({}, { ONLY_PROJECT: "1" })).toEqual([]);
  });
});
