import { describe, expect, it } from "vitest";
import { EMBED_TOKEN_PATTERN, isSecretPath } from "@replit-clone/shared";
import { isEmbedPreview, isEmbedView } from "./embedService.js";

/** The rules that decide what an unauthenticated reader can reach.
 *
 *  Tested here rather than only through the endpoints, because each of them is
 *  a single predicate standing between a stranger and a project's source, and a
 *  predicate is the one thing that can be pinned down exactly.
 */

describe("isSecretPath", () => {
  it("hides an environment file in every shape it ships in", () => {
    for (const path of [
      ".env",
      ".env.local",
      ".env.production",
      ".env.production.local",
      "apps/server/.env",
      "packages/api/.env.test",
    ]) {
      expect(isSecretPath(path), path).toBe(true);
    }
  });

  it("hides private keys and host credentials", () => {
    for (const path of [
      "certs/server.key",
      "certs/server.pem",
      "keystore.jks",
      ".ssh/id_rsa",
      "deploy/id_ed25519",
      ".npmrc",
      "home/.netrc",
      ".aws/credentials",
      "config/credentials.json",
      "gcp/service-account-prod.json",
      "secrets.yaml",
      "config/secret.toml",
    ]) {
      expect(isSecretPath(path), path).toBe(true);
    }
  });

  it("leaves ordinary source alone", () => {
    // The rule is a floor, not a filter. Hiding half a project would make the
    // embed useless, which is its own kind of failure.
    for (const path of [
      "src/App.tsx",
      "src/environment.ts",
      "src/envConfig.ts",
      "README.md",
      "package.json",
      "docs/keyboard.md",
      "src/lib/keyring.ts",
      "public/env-banner.svg",
    ]) {
      expect(isSecretPath(path), path).toBe(false);
    }
  });

  it("is case-insensitive, because a filesystem need not be", () => {
    expect(isSecretPath("Certs/Server.PEM")).toBe(true);
    expect(isSecretPath(".ENV.local")).toBe(true);
  });
});

describe("EMBED_TOKEN_PATTERN", () => {
  it("accepts what randomBytes(32).toString('base64url') produces", () => {
    // 32 bytes is 43 base64url characters, unpadded.
    expect(EMBED_TOKEN_PATTERN.test("a".repeat(43))).toBe(true);
    expect(EMBED_TOKEN_PATTERN.test("aB3-_".padEnd(43, "x"))).toBe(true);
  });

  it("rejects anything else, before it can reach a query", () => {
    for (const bad of [
      "",
      "short",
      "a".repeat(42),
      "a".repeat(44),
      // Padding, slashes and plus signs belong to base64, not base64url.
      `${"a".repeat(41)}==`,
      `${"a".repeat(42)}/`,
      `${"a".repeat(42)}+`,
      // What somebody probing the public endpoint would actually send.
      "../../etc/passwd",
      "%2e%2e%2f".repeat(4),
    ]) {
      expect(EMBED_TOKEN_PATTERN.test(bad), bad).toBe(false);
    }
  });
});

describe("the stored settings", () => {
  it("recognises the values it writes", () => {
    expect(isEmbedView("split")).toBe(true);
    expect(isEmbedView("code")).toBe(true);
    expect(isEmbedView("preview")).toBe(true);
    expect(isEmbedPreview("none")).toBe(true);
    expect(isEmbedPreview("deployment")).toBe(true);
  });

  it("refuses a live container preview by name", () => {
    // Not an oversight, and worth a test that says so: an anonymous page view
    // must not be able to start somebody's container. See EmbedSettings.
    expect(isEmbedPreview("live")).toBe(false);
    expect(isEmbedPreview("container")).toBe(false);
  });

  it("refuses anything else, including the shapes a body can smuggle", () => {
    for (const bad of [undefined, null, 1, {}, [], "", "SPLIT", "code "]) {
      const label = JSON.stringify(bad) ?? "undefined";
      expect(isEmbedView(bad), label).toBe(false);
      expect(isEmbedPreview(bad), label).toBe(false);
    }
  });
});
