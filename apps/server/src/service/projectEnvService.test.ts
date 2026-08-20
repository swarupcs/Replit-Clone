import { describe, expect, it } from "vitest";
import { envVarsSchema, parseEnvVars, toDockerEnv } from "./projectEnvService.js";

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
