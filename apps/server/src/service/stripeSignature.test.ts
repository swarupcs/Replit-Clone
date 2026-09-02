import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyStripeSignature } from "./stripeSignature.js";

/** The one part of billing that has to be right before any money moves, and
 *  the one part §9.4 could build with no account in existence: a function
 *  taking a payload, a header and a secret is testable exactly.
 *
 *  Everything downstream of this trusts what it says. A webhook that accepted
 *  a forged event would let anybody grant themselves any plan by POSTing to a
 *  public endpoint.
 */

const SECRET = "whsec_test";
const BODY = '{"id":"evt_1","type":"customer.subscription.updated"}';
const NOW = new Date("2026-09-02T12:00:00.000Z");

function sign(body: string, at: Date = NOW, secret = SECRET): string {
  const t = Math.floor(at.getTime() / 1000);
  const v1 = createHmac("sha256", secret).update(`${String(t)}.${body}`).digest("hex");
  return `t=${String(t)},v1=${v1}`;
}

describe("a genuine event", () => {
  it("is accepted", () => {
    expect(verifyStripeSignature(BODY, sign(BODY), SECRET, NOW).ok).toBe(true);
  });

  /** The processor sends more than one signature during a secret rotation,
   *  which is the only way to rotate a secret without dropping deliveries. */
  it("is accepted when one of several signatures matches", () => {
    const header = `${sign(BODY)},v1=${"0".repeat(64)}`;

    expect(verifyStripeSignature(BODY, header, SECRET, NOW).ok).toBe(true);
  });

  /** The signature covers the bytes that were sent. A route that parsed the
   *  JSON and re-stringified it would fail every single delivery, which is
   *  exactly the bug `express.raw` exists to prevent. */
  it("is rejected if so much as the whitespace changed", () => {
    // A processor sends the bytes it sends. This one has a space after the
    // colon; `JSON.parse` then `JSON.stringify` does not, and the digest is
    // over a different string.
    const sent = '{"id": "evt_1", "type": "customer.subscription.updated"}';
    const restringified = JSON.stringify(JSON.parse(sent) as unknown);
    const header = sign(sent);

    expect(restringified).not.toBe(sent);
    expect(verifyStripeSignature(sent, header, SECRET, NOW).ok).toBe(true);
    expect(verifyStripeSignature(restringified, header, SECRET, NOW).ok).toBe(false);
  });
});

describe("a forged event", () => {
  it("is rejected when the body was altered", () => {
    const header = sign(BODY);
    const tampered = BODY.replace("evt_1", "evt_2");

    expect(verifyStripeSignature(tampered, header, SECRET, NOW).ok).toBe(false);
  });

  it("is rejected when signed with a different secret", () => {
    const header = sign(BODY, NOW, "whsec_someone_else");

    expect(verifyStripeSignature(BODY, header, SECRET, NOW).ok).toBe(false);
  });

  /** Without the timestamp check a captured request stays valid forever, and
   *  "the signature is correct" would only mean "this was genuine once". */
  it("is rejected when replayed later", () => {
    const header = sign(BODY, new Date(NOW.getTime() - 10 * 60 * 1000));

    expect(verifyStripeSignature(BODY, header, SECRET, NOW).ok).toBe(false);
  });

  /** A clock ahead of ours is the same replay window in the other direction,
   *  and a signature dated next week would otherwise be valid all week. */
  it("is rejected when dated in the future", () => {
    const header = sign(BODY, new Date(NOW.getTime() + 10 * 60 * 1000));

    expect(verifyStripeSignature(BODY, header, SECRET, NOW).ok).toBe(false);
  });

  /** v0 is the older scheme. Accepting both would mean accepting whichever an
   *  attacker preferred. */
  it("does not accept a v0 signature", () => {
    const t = Math.floor(NOW.getTime() / 1000);
    const digest = createHmac("sha256", SECRET)
      .update(`${String(t)}.${BODY}`)
      .digest("hex");

    expect(
      verifyStripeSignature(BODY, `t=${String(t)},v0=${digest}`, SECRET, NOW).ok,
    ).toBe(false);
  });
});

describe("a malformed header", () => {
  /** `timingSafeEqual` throws on a length mismatch rather than returning
   *  false, so a short signature would be a 500 on a public endpoint. */
  it.each([
    ["empty", ""],
    ["no timestamp", `v1=${"a".repeat(64)}`],
    ["no signature", "t=1772452800"],
    ["not a timestamp", `t=yesterday,v1=${"a".repeat(64)}`],
    ["a signature of the wrong length", "t=1772452800,v1=abc"],
    ["nonsense", "hello"],
  ])("is refused rather than thrown on: %s", (_name, header) => {
    expect(verifyStripeSignature(BODY, header, SECRET, NOW).ok).toBe(false);
  });

  /** A deployment with no secret cannot tell a real event from a forged one,
   *  so it accepts neither — rather than treating an empty secret as one that
   *  everything matches. */
  it("is refused when there is no secret at all", () => {
    expect(verifyStripeSignature(BODY, sign(BODY, NOW, ""), "", NOW).ok).toBe(false);
  });
});
