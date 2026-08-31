import { afterEach, describe, expect, it } from "vitest";
import {
  envVarsEncryptedAtRest,
  envVarsSchema,
  parseEnvVars,
  toDockerEnv,
} from "./projectEnvService.js";
import { seal } from "../lib/secretBox.js";
import { env } from "../config/env.js";

const accepts = (vars: unknown) => envVarsSchema.safeParse(vars).success;

describe("envVarsSchema", () => {
  it("accepts ordinary names", () => {
    expect(accepts({ API_URL: "https://x", PORT_2: "1", _private: "x" })).toBe(true);
  });

  it("accepts an empty set", () => {
    expect(accepts({})).toBe(true);
  });

  it.each([
    ["a leading digit", { "2FAST": "x" }],
    ["a hyphen", { "MY-VAR": "x" }],
    ["a space", { "MY VAR": "x" }],
    ["an equals sign, which would split the pair", { "A=B": "x" }],
    ["a newline, which would inject a second variable", { "A\nB": "x" }],
    ["an empty name", { "": "x" }],
  ])("rejects %s", (_label, vars) => {
    expect(accepts(vars)).toBe(false);
  });

  it("rejects a non-string value", () => {
    expect(accepts({ COUNT: 1 })).toBe(false);
  });

  it.each(["HOME", "PATH", "HOSTNAME", "PREVIEW_BASE", "DEV_PORT"])(
    "refuses to let a project override %s",
    (name) => {
      // Overriding these would let a project point its dev server somewhere the
      // proxy cannot reach, or shadow the home the package caches live in.
      expect(accepts({ [name]: "x" })).toBe(false);
    },
  );

  it("caps how many variables one project can hold", () => {
    const many = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`VAR_${String(i)}`, "x"]),
    );
    expect(accepts(many)).toBe(false);
  });

  it("caps the length of a value", () => {
    expect(accepts({ BIG: "x".repeat(4097) })).toBe(false);
    expect(accepts({ BIG: "x".repeat(4096) })).toBe(true);
  });
});

describe("parseEnvVars", () => {
  it("reads a stored object", () => {
    expect(parseEnvVars({ A: "1", B: "2" })).toEqual({ A: "1", B: "2" });
  });

  it.each([
    ["null", null],
    ["an array", ["A=1"]],
    ["a string", "A=1"],
    ["a number", 5],
  ])("treats %s as empty rather than throwing", (_label, raw) => {
    expect(parseEnvVars(raw)).toEqual({});
  });

  it("drops entries a hand-edited row could have introduced", () => {
    expect(parseEnvVars({ GOOD: "1", "BAD NAME": "2", ALSO_BAD: 3 })).toEqual({
      GOOD: "1",
    });
  });
});

describe("toDockerEnv", () => {
  it("renders NAME=value pairs", () => {
    expect(toDockerEnv({ A: "1", B: "two" })).toEqual(["A=1", "B=two"]);
  });

  it("keeps a value containing an equals sign intact", () => {
    // Docker splits on the FIRST =, so this round-trips correctly.
    expect(toDockerEnv({ DSN: "postgres://u:p@h/db?a=b" })).toEqual([
      "DSN=postgres://u:p@h/db?a=b",
    ]);
  });

  it("renders an empty value", () => {
    expect(toDockerEnv({ EMPTY: "" })).toEqual(["EMPTY="]);
  });
});

/** Reading a column that holds ciphertext, plain text, or both.
 *
 *  Both, necessarily: this column was plain text until it was not, and a
 *  server that could not read what it wrote last week would lose every
 *  variable on the machine at the moment it was upgraded.
 *
 *  The schema is parsed once at import, so a test wanting a particular key
 *  writes it onto the parsed object and puts it back afterwards.
 */
describe("reading stored values", () => {
  const original = env.SECRET_ENCRYPTION_KEY;
  const KEY = Buffer.alloc(32, 5).toString("base64");

  afterEach(() => {
    env.SECRET_ENCRYPTION_KEY = original;
  });

  it("opens a sealed value", () => {
    env.SECRET_ENCRYPTION_KEY = KEY;

    expect(parseEnvVars({ STRIPE_KEY: seal("sk_live_hunter2") })).toEqual({
      STRIPE_KEY: "sk_live_hunter2",
    });
  });

  it("passes through a row written before this was encrypted", () => {
    // The upgrade path. Without it, turning encryption on empties every
    // project's environment on the next read.
    env.SECRET_ENCRYPTION_KEY = KEY;

    expect(parseEnvVars({ API_URL: "https://example.com" })).toEqual({
      API_URL: "https://example.com",
    });
  });

  it("reads a row that is half sealed and half not", () => {
    // Exactly what a backfill interrupted part-way leaves behind.
    env.SECRET_ENCRYPTION_KEY = KEY;

    expect(
      parseEnvVars({ OLD: "plain", NEW: seal("sealed") }),
    ).toEqual({ OLD: "plain", NEW: "sealed" });
  });

  it("drops a value it cannot open rather than returning the ciphertext", () => {
    // The failure that matters. A wrong key must not silently become "the
    // secret is this base64 blob" -- the container would start with a
    // credential that is not a credential, and nothing would say why.
    env.SECRET_ENCRYPTION_KEY = KEY;
    const sealed = seal("sk_live_hunter2");
    env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString("base64");

    const read = parseEnvVars({ STRIPE_KEY: sealed, API_URL: "https://x" });

    expect(read["STRIPE_KEY"]).toBeUndefined();
    expect(JSON.stringify(read)).not.toContain(sealed);
    // One unreadable variable costs one variable. A project with nine good
    // ones should still start with nine.
    expect(read).toEqual({ API_URL: "https://x" });
  });

  it("still drops the entries a hand-edited row could introduce", () => {
    env.SECRET_ENCRYPTION_KEY = KEY;

    expect(
      parseEnvVars({ GOOD: seal("1"), "BAD NAME": seal("2"), ALSO_BAD: 3 }),
    ).toEqual({ GOOD: "1" });
  });
});

describe("envVarsEncryptedAtRest", () => {
  const original = env.SECRET_ENCRYPTION_KEY;

  afterEach(() => {
    env.SECRET_ENCRYPTION_KEY = original;
  });

  it("is false with no key, so the panel can say so", () => {
    // A server that stores these in the clear and looks identical to one that
    // does not is a panel that lies on one of the two.
    delete env.SECRET_ENCRYPTION_KEY;
    expect(envVarsEncryptedAtRest()).toBe(false);
  });

  it("is false for a key that is the wrong length", () => {
    env.SECRET_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(envVarsEncryptedAtRest()).toBe(false);
  });

  it("is true for a usable key", () => {
    env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
    expect(envVarsEncryptedAtRest()).toBe(true);
  });
});
