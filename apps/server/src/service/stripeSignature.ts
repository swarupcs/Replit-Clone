import { createHmac, timingSafeEqual } from "node:crypto";

/** Verifying that a webhook really came from the processor.
 *
 *  Written out rather than taken from the SDK, for the reason §9.4 gives: this
 *  is the one part of billing that must work before there is an account to
 *  test against, and a function taking a payload, a header and a secret can be
 *  tested exactly — with no key, no network and no library. It is also about
 *  forty lines, all of them the interesting kind.
 *
 *  The header looks like `t=1614556800,v1=<hex>,v0=<hex>`. The signed payload
 *  is `${timestamp}.${rawBody}` — which is why the route must read the raw
 *  body: `JSON.parse` followed by `JSON.stringify` produces a different string
 *  and every signature fails.
 */

/** How far out of step the sender's clock may be.
 *
 *  A replay window, and the reason the timestamp is signed at all: without
 *  this check a captured request stays valid forever, and "the signature is
 *  correct" would only mean "this was genuine at some point".
 */
const TOLERANCE_SECONDS = 300;

export interface SignatureResult {
  ok: boolean;
  /** Why not, for the log. Never returned to the caller: an endpoint that
   *  explains which half of the check failed is an oracle for guessing the
   *  other half. */
  reason?: string;
}

function parseHeader(header: string): { timestamp?: string; signatures: string[] } {
  const signatures: string[] = [];
  let timestamp: string | undefined;

  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=");
    if (!key || !value) continue;
    if (key === "t") timestamp = value;
    // v1 only. v0 is the older scheme and accepting it would mean accepting
    // whichever of the two an attacker preferred.
    if (key === "v1") signatures.push(value);
  }

  return { timestamp, signatures };
}

/** Constant time, and length-safe.
 *
 *  `timingSafeEqual` throws on a length mismatch rather than returning false,
 *  which turns a malformed header into a 500 — so the lengths are compared
 *  first. That comparison is not a leak: the length of a hex digest is public.
 */
function matches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyStripeSignature(
  rawBody: string,
  header: string,
  secret: string,
  now = new Date(),
): SignatureResult {
  if (!secret) return { ok: false, reason: "no signing secret configured" };
  if (!header) return { ok: false, reason: "no signature header" };

  const { timestamp, signatures } = parseHeader(header);
  if (!timestamp || signatures.length === 0) {
    return { ok: false, reason: "malformed signature header" };
  }

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return { ok: false, reason: "unparseable timestamp" };

  const ageSeconds = Math.abs(Math.floor(now.getTime() / 1000) - sent);
  if (ageSeconds > TOLERANCE_SECONDS) {
    // A correct signature on an old request is a replay, and the whole reason
    // the timestamp is inside the signed payload.
    return { ok: false, reason: "timestamp outside tolerance" };
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  // Any of them: the processor sends more than one during a secret rotation,
  // which is the only way to rotate without dropping deliveries.
  const ok = signatures.some((signature) => matches(expected, signature));
  return ok ? { ok } : { ok: false, reason: "no matching signature" };
}
