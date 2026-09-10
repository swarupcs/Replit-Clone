import { createHmac, timingSafeEqual } from "node:crypto";

/** Verifying that a webhook really came from GitHub.
 *
 *  Written out rather than taken from a library, for the same reason §9.4 gives
 *  for the billing one: a function taking a payload, a header and a secret can
 *  be tested exactly, with no key, no network and no App installed. It is also
 *  short, and all of it is the interesting kind of short.
 *
 *  **The scheme is not the billing one and the difference matters.** GitHub
 *  sends `X-Hub-Signature-256: sha256=<hex>`, an HMAC over the raw body and
 *  nothing else — **there is no timestamp in it**. So the replay window that
 *  `stripeSignature.ts` gets for free does not exist here: a captured delivery
 *  stays valid forever, and "the signature is correct" really does only mean
 *  "GitHub sent this at some point". Replay is answered at the other end, by
 *  refusing a delivery id that has already been handled — which is why that
 *  dedupe is a correctness requirement here and merely an efficiency one there.
 */

export interface SignatureResult {
  ok: boolean;
  /** Why not, for the log. Never returned to the caller: an endpoint that
   *  explains which half of the check failed is an oracle for guessing the
   *  other half. */
  reason?: string;
}

/** Constant time, and length-safe.
 *
 *  `timingSafeEqual` throws on a length mismatch rather than returning false,
 *  which would turn a malformed header into a 500 — so the lengths are compared
 *  first. That comparison is not a leak: the length of a hex digest is public.
 */
function matches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyGithubSignature(
  rawBody: string,
  header: string,
  secret: string,
): SignatureResult {
  if (!secret) return { ok: false, reason: "no signing secret configured" };
  if (!header) return { ok: false, reason: "no signature header" };

  // `sha256=` and not `sha1=`. GitHub still sends `X-Hub-Signature` with SHA-1
  // beside this one, and accepting either would mean accepting whichever an
  // attacker preferred — the same reason the billing verifier takes v1 only.
  const [algorithm, presented] = header.split("=");
  if (algorithm !== "sha256" || !presented) {
    return { ok: false, reason: "malformed signature header" };
  }

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  if (!matches(expected, presented)) return { ok: false, reason: "signature mismatch" };

  return { ok: true };
}
