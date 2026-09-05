import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  codeForStep,
  currentCode,
  generateSecret,
  otpauthUrl,
  stepFor,
  verifyCode,
} from "./totp.js";

/** TOTP, RFC 6238.
 *
 *  The first group is the only test here that could have caught a wrong
 *  implementation: the official vectors, from the RFC's own appendix. Every
 *  other assertion in this file would pass just as happily against an
 *  algorithm that agreed with itself and with nothing else in the world —
 *  which, for a thing whose entire job is to agree with a phone, is the
 *  failure that matters.
 */

/** The RFC's shared secret: the ASCII digits 1234567890 repeated. */
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "utf8"));

describe("the RFC 6238 vectors", () => {
  /** The RFC prints eight digits; this implementation produces six, which are
   *  the last six of each — truncation is the outer step, so a six-digit
   *  implementation is a suffix of the eight-digit one. */
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ])("matches at T=%i", (seconds, expected) => {
    expect(codeForStep(RFC_SECRET, stepFor(seconds * 1000))).toBe(expected);
  });

  /** The secret in the RFC's own base32 form, so a broken encoder cannot be
   *  hidden by a matching broken decoder above. */
  it("encodes the RFC's secret the way the RFC writes it", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });
});

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = Buffer.from([0, 1, 255, 128, 64, 7, 200]);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });

  /** People transcribe these from a screen, so spaces and padding arrive with
   *  the secret and are noise rather than data. */
  it("ignores spaces and padding on the way in", () => {
    const secret = base32Encode(Buffer.from("hello world!", "utf8"));
    const spaced = `${secret.slice(0, 4)} ${secret.slice(4)}==`;

    expect(base32Decode(spaced).equals(base32Decode(secret))).toBe(true);
  });

  it("refuses something that is not base32", () => {
    expect(() => base32Decode("0189!")).toThrow(/base32/);
  });
});

describe("verifying a code", () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;

  it("accepts the code for right now", () => {
    expect(verifyCode(secret, currentCode(secret, now), now)).toEqual({
      ok: true,
      step: stepFor(now),
    });
  });

  /** Phones drift, and somebody who starts typing at second 29 finishes in the
   *  next window. Refusing them is a support request, not a defence. */
  it("accepts one step either side", () => {
    const before = codeForStep(secret, stepFor(now) - 1);
    const after = codeForStep(secret, stepFor(now) + 1);

    expect(verifyCode(secret, before, now).ok).toBe(true);
    expect(verifyCode(secret, after, now).ok).toBe(true);
  });

  /** Wider than one step and a code seen over a shoulder stays useful for
   *  minutes. */
  it("refuses two steps away", () => {
    const stale = codeForStep(secret, stepFor(now) - 2);

    expect(verifyCode(secret, stale, now).ok).toBe(false);
  });

  /** Which step matched is what the replay guard is built on: without it a
   *  code stays usable for the rest of its window. */
  it("reports which step matched", () => {
    const previous = stepFor(now) - 1;

    expect(verifyCode(secret, codeForStep(secret, previous), now).step).toBe(
      previous,
    );
  });

  it("takes a code typed with a space in it", () => {
    const code = currentCode(secret, now);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;

    expect(verifyCode(secret, spaced, now).ok).toBe(true);
  });

  /** `timingSafeEqual` throws on a length mismatch rather than returning
   *  false, so a short code would have been a 500 instead of a refusal. */
  it("refuses a wrong-length code without throwing", () => {
    expect(verifyCode(secret, "123", now).ok).toBe(false);
    expect(verifyCode(secret, "1234567", now).ok).toBe(false);
    expect(verifyCode(secret, "", now).ok).toBe(false);
    expect(verifyCode(secret, "abcdef", now).ok).toBe(false);
  });

  it("refuses another account's code", () => {
    const other = generateSecret();

    expect(verifyCode(secret, currentCode(other, now), now).ok).toBe(false);
  });
});

describe("the secret", () => {
  /** Twenty bytes is RFC 4226's recommendation and what every app is tested
   *  against; thirty-two base32 characters is what that looks like. */
  it("is twenty bytes", () => {
    expect(base32Decode(generateSecret())).toHaveLength(20);
  });

  it("is different every time", () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });
});

describe("the otpauth URL", () => {
  const url = otpauthUrl({
    secret: "ABCDEFGH",
    account: "someone@example.com",
    issuer: "editor.example.com",
  });

  /** The issuer appears twice because apps disagree about which they read, and
   *  one that reads neither shows a bare email address among everything else
   *  the person has enrolled. */
  it("names the issuer in both places apps look", () => {
    expect(url).toContain(
      encodeURIComponent("editor.example.com:someone@example.com"),
    );
    expect(url).toContain("issuer=editor.example.com");
  });

  /** SHA-1 and six digits are stated even though they are the defaults,
   *  because an app that ignores them — Google Authenticator does — has to end
   *  up on the same parameters this server uses either way. */
  it("pins the parameters this server actually verifies with", () => {
    expect(url).toContain("algorithm=SHA1");
    expect(url).toContain("digits=6");
    expect(url).toContain("period=30");
  });
});
