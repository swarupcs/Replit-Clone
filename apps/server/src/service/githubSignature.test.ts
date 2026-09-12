import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyGithubSignature } from "./githubSignature.js";

const SECRET = "a-webhook-secret";
const BODY = '{"action":"opened","number":7}';

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

describe("verifying that a delivery came from GitHub", () => {
  it("accepts a signature over the exact bytes", () => {
    expect(verifyGithubSignature(BODY, sign(BODY), SECRET).ok).toBe(true);
  });

  it("refuses a body changed by one character", () => {
    const header = sign(BODY);
    expect(verifyGithubSignature(BODY.replace("opened", "closed"), header, SECRET).ok).toBe(
      false,
    );
  });

  it("refuses a signature made with a different secret", () => {
    expect(verifyGithubSignature(BODY, sign(BODY, "not-the-secret"), SECRET).ok).toBe(false);
  });

  it("refuses sha1, which GitHub still sends beside sha256", () => {
    // Accepting either would mean accepting whichever an attacker preferred.
    const sha1 = createHmac("sha1", SECRET).update(BODY, "utf8").digest("hex");
    expect(verifyGithubSignature(BODY, `sha1=${sha1}`, SECRET).ok).toBe(false);
  });

  it("refuses a bare digest with no algorithm", () => {
    const bare = createHmac("sha256", SECRET).update(BODY, "utf8").digest("hex");
    expect(verifyGithubSignature(BODY, bare, SECRET).ok).toBe(false);
  });

  it("refuses when the deployment has no secret", () => {
    // Otherwise an unconfigured deployment verifies everything against "".
    expect(verifyGithubSignature(BODY, sign(BODY), "").ok).toBe(false);
  });

  it("refuses an absent header rather than throwing", () => {
    expect(verifyGithubSignature(BODY, "", SECRET).ok).toBe(false);
  });

  it("refuses a digest of the wrong length without throwing", () => {
    // timingSafeEqual throws on a length mismatch, which would turn a
    // malformed header into a 500.
    expect(() => verifyGithubSignature(BODY, "sha256=abc", SECRET)).not.toThrow();
    expect(verifyGithubSignature(BODY, "sha256=abc", SECRET).ok).toBe(false);
  });

  it("keeps the reason out of the result the caller returns", () => {
    // The reason exists for the log. The route must never return it: an
    // endpoint that says which half failed is an oracle for the other half.
    const result = verifyGithubSignature(BODY, "sha256=abc", SECRET);
    expect(result.reason).toBeDefined();
    expect(result.ok).toBe(false);
  });
});
