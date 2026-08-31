import { afterEach, describe, expect, it } from "vitest";
import {
  isSecretBoxConfigured,
  looksSealed,
  open,
  seal,
  secretsMatch,
} from "./secretBox.js";
import { env } from "../config/env.js";

const TOKEN = "gho_a-token-that-looks-real-enough";

/** The schema is parsed once at import, so a test that wants a different key
 *  writes it onto the parsed object and puts it back afterwards. */
const original = env.SECRET_ENCRYPTION_KEY;

afterEach(() => {
  env.SECRET_ENCRYPTION_KEY = original;
});

describe("seal and open", () => {
  it("round-trips a secret", () => {
    expect(open(seal(TOKEN))).toBe(TOKEN);
  });

  it("never contains the plaintext", () => {
    // The whole point: what lands in the column is not the token.
    expect(seal(TOKEN)).not.toContain(TOKEN);
    expect(seal(TOKEN)).not.toContain("a-token");
  });

  it("produces a different ciphertext every time", () => {
    // A fresh nonce per seal. Without it, two users with the same token would
    // be visibly the same row, and GCM's security argument collapses.
    expect(seal(TOKEN)).not.toBe(seal(TOKEN));
  });

  it("refuses a ciphertext that has been tampered with", () => {
    const sealed = seal(TOKEN);
    const [version, iv, tag, body] = sealed.split(".");

    // Flip a character of the body. GCM authenticates, so this must fail
    // rather than decrypt to something an attacker chose.
    const flipped = `${body?.startsWith("A") ? "B" : "A"}${body?.slice(1) ?? ""}`;

    expect(() => open([version, iv, tag, flipped].join("."))).toThrow();
  });

  it("refuses a ciphertext whose tag has been swapped", () => {
    const [version, iv, , body] = seal(TOKEN).split(".");
    const [, , otherTag] = seal("something else").split(".");

    expect(() => open([version, iv, otherTag, body].join("."))).toThrow();
  });

  it("refuses something that is not a sealed value at all", () => {
    expect(() => open(TOKEN)).toThrow(/Not a sealed value/);
    expect(() => open("")).toThrow(/Not a sealed value/);
    expect(() => open("v1.a.b")).toThrow(/Not a sealed value/);
  });

  it("refuses a value sealed under a different key", () => {
    const sealed = seal(TOKEN);

    env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

    // Rotating the key must not silently produce garbage; it must fail.
    expect(() => open(sealed)).toThrow();
  });
});

describe("isSecretBoxConfigured", () => {
  it("is true with a well-formed key", () => {
    expect(isSecretBoxConfigured()).toBe(true);
  });

  it("is false with no key, rather than throwing", () => {
    // The features that need this report themselves off; they do not take the
    // process down at boot for a deployment that never uses them.
    delete env.SECRET_ENCRYPTION_KEY;
    expect(isSecretBoxConfigured()).toBe(false);
  });

  it("is false for a key of the wrong length", () => {
    // A truncated paste is the likely mistake, and it must not look configured.
    env.SECRET_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(isSecretBoxConfigured()).toBe(false);
  });

  it("says what to do when a short key is actually used", () => {
    env.SECRET_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(() => seal(TOKEN)).toThrow(/openssl rand -base64 32/);
  });
});

describe("secretsMatch", () => {
  it("is true for equal secrets and false otherwise", () => {
    expect(secretsMatch("abc", "abc")).toBe(true);
    expect(secretsMatch("abc", "abd")).toBe(false);
  });

  it("is false for different lengths rather than throwing", () => {
    // timingSafeEqual throws on a length mismatch, which would itself leak.
    expect(secretsMatch("abc", "abcd")).toBe(false);
  });
});

describe("looksSealed", () => {
  it("recognises what seal produced", () => {
    expect(looksSealed(seal(TOKEN))).toBe(true);
  });

  it.each([
    ["plain text", "sk_live_hunter2"],
    ["an empty string", ""],
    ["something with dots in it", "a.b.c"],
    ["a value with the right shape but the wrong version", "v2.aaaa.bbbb.cccc"],
    ["a URL, which has no dots in the right places", "postgres://u:p@h/db"],
    ["a JWT, which is three parts rather than four", "eyJhbGc.eyJzdWI.sig"],
  ])("rejects %s", (_label, value) => {
    expect(looksSealed(value)).toBe(false);
  });

  it("still recognises a value sealed under a DIFFERENT key", () => {
    // The distinction the whole function exists for. `open` throws for both a
    // wrong key and plain text, so "did open throw" cannot tell them apart --
    // and treating a wrong-key ciphertext as plain text would hand the
    // ciphertext back as though it were the secret, so a key rotation would
    // quietly start serving garbage instead of failing.
    env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
    const sealed = seal(TOKEN);
    env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

    expect(looksSealed(sealed)).toBe(true);
    expect(() => open(sealed)).toThrow();
  });
});
