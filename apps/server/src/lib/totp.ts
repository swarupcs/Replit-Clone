import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Time-based one-time passwords, RFC 6238. plan.md §11.6.
 *
 *  Written here rather than taken from a dependency, and the reason is
 *  proportion rather than pride: the whole algorithm is an HMAC, a big-endian
 *  counter and a truncation, and every line of it is below. Adding a package to
 *  the authentication path — the one path where a supply-chain compromise is
 *  indistinguishable from having no authentication at all — costs more than it
 *  saves for forty lines.
 *
 *  SHA-1, six digits, thirty seconds. Not because they are the strongest
 *  choices but because they are the ones every authenticator app implements:
 *  Google Authenticator ignores the `algorithm` and `digits` parameters of an
 *  otpauth URL entirely, so a server that used SHA-256 would produce codes
 *  that simply never match, with nothing to say why. The security of TOTP does
 *  not rest on the hash here — it rests on the secret staying secret and on
 *  the code being useless thirty seconds later.
 */

const DIGITS = 6;
const STEP_SECONDS = 30;

/** How far either side of now a code is accepted.
 *
 *  One step, which is thirty seconds each way. Phones drift, and a person who
 *  starts typing at second 29 finishes in the next window; refusing them is a
 *  support request, not a defence. Wider than this and a stolen code stays
 *  useful for minutes.
 */
const WINDOW_STEPS = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, unpadded — what every authenticator app expects a secret
 *  to look like, and the only reason base32 is here rather than hex. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];

  return output;
}

export function base32Decode(input: string): Buffer {
  // Spaces are how people transcribe these, and padding is how some sites
  // write them. Both are noise rather than data.
  const cleaned = input.replace(/[\s=]/g, "").toUpperCase();

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error("Not a base32 secret");

    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/** A fresh secret. Twenty bytes, which is the SHA-1 block size RFC 4226
 *  recommends and what every app is tested against. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The counter for a moment in time. Exported because the tests and the replay
 *  guard both need to talk about steps rather than seconds. */
export function stepFor(atMs: number): number {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

/** The code for one counter value. RFC 4226's dynamic truncation. */
export function codeForStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  // Big-endian 64-bit. Written as two 32-bit halves because a step is far
  // below 2^53 and `writeBigUInt64BE` would mean carrying BigInts through the
  // whole file for no gain.
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);

  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();

  // The low four bits of the last byte choose where to read from, which is
  // what stops the code being a fixed slice of the digest.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;

  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** The code a phone would be showing right now. For tests and for nothing
 *  else — the server never needs to know the current code, only whether one it
 *  was given matches. */
export function currentCode(secret: string, atMs = Date.now()): string {
  return codeForStep(secret, stepFor(atMs));
}

export interface TotpResult {
  /** Whether the code matched. */
  ok: boolean;
  /** Which counter it matched, so the caller can refuse to accept it twice.
   *  A TOTP code is valid for a whole window, so without this a code read over
   *  somebody's shoulder — or out of a phished form — works again for the next
   *  thirty seconds. */
  step?: number;
}

/** Checks a code against the accepted window.
 *
 *  Constant-time, and that is not theatre: the comparison is against a value
 *  an attacker supplies and can vary a digit at a time, which is the textbook
 *  shape for a timing oracle. Length is checked first because
 *  `timingSafeEqual` throws on a mismatch rather than returning false, and a
 *  thrown error here would read as a server fault rather than a wrong code.
 */
export function verifyCode(
  secret: string,
  code: string,
  atMs = Date.now(),
): TotpResult {
  const cleaned = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(cleaned)) return { ok: false };

  const now = stepFor(atMs);
  const given = Buffer.from(cleaned, "utf8");

  for (let offset = -WINDOW_STEPS; offset <= WINDOW_STEPS; offset += 1) {
    const step = now + offset;
    const expected = Buffer.from(codeForStep(secret, step), "utf8");
    if (expected.length === given.length && timingSafeEqual(expected, given)) {
      return { ok: true, step };
    }
  }

  return { ok: false };
}

/** The `otpauth://` URL an authenticator app scans.
 *
 *  The issuer appears twice — once as a label prefix and once as a parameter —
 *  because apps disagree about which they read, and one that reads neither
 *  shows the account as a bare email address among everything else the person
 *  has enrolled.
 */
export function otpauthUrl(options: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = `${options.issuer}:${options.account}`;
  const params = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });

  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
