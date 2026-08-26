import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { env } from "../config/env.js";

/** Authenticated encryption for secrets the server must keep and later use.
 *
 *  A GitHub token is not a password: it cannot be hashed, because the point is
 *  to spend it later. So it is encrypted, under a key that lives in the
 *  environment rather than in the database — a leaked dump then hands over
 *  ciphertext and nothing else.
 *
 *  AES-256-GCM rather than CBC or CTR: it authenticates as well as encrypts, so
 *  a ciphertext someone has tampered with fails to open instead of decrypting
 *  to something attacker-chosen.
 */

const ALGORITHM = "aes-256-gcm";
/** 96 bits, which is what GCM is specified for; other lengths are slower and
 *  weaken the nonce-collision bound. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** Stamped into every sealed value so a future scheme can be told apart from
 *  this one without guessing. */
const VERSION = "v1";

/** Thrown for a configuration mistake rather than a runtime one, so it reads
 *  as what it is at the point somebody sees it. */
export class SecretBoxUnconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxUnconfiguredError";
  }
}

function decodeKey(raw: string): Buffer {
  // Base64 rather than hex, because 32 bytes of hex is 64 characters of
  // something people copy by hand and truncate.
  const key = Buffer.from(raw, "base64");

  if (key.length !== KEY_BYTES) {
    throw new SecretBoxUnconfiguredError(
      `SECRET_ENCRYPTION_KEY must decode to ${String(KEY_BYTES)} bytes; ` +
        `got ${String(key.length)}. Generate one with: ` +
        `openssl rand -base64 32`,
    );
  }

  return key;
}

/** Whether the server can keep secrets at all.
 *
 *  Read at call time rather than at import: a feature that needs this reports
 *  itself unconfigured, the same way GitHub sign-in does, instead of taking the
 *  process down at boot for a feature nobody is using.
 */
export function isSecretBoxConfigured(): boolean {
  const raw = env.SECRET_ENCRYPTION_KEY;
  if (!raw) return false;

  try {
    decodeKey(raw);
    return true;
  } catch {
    return false;
  }
}

function key(): Buffer {
  const raw = env.SECRET_ENCRYPTION_KEY;
  if (!raw) {
    throw new SecretBoxUnconfiguredError(
      "SECRET_ENCRYPTION_KEY is not set, so this server cannot store secrets.",
    );
  }

  return decodeKey(raw);
}

/** Encrypts a value for storage. The result is safe to put in a column. */
export function seal(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);

  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}

/** Reverses `seal`. Throws if the value was tampered with, was sealed under a
 *  different key, or is not a sealed value at all. */
export function open(sealed: string): string {
  const parts = sealed.split(".");
  const [version, ivPart, tagPart, bodyPart] = parts;

  if (parts.length !== 4 || version !== VERSION || !ivPart || !tagPart || !bodyPart) {
    throw new Error("Not a sealed value");
  }

  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");

  // Checked before handing them to OpenSSL: a wrong-length IV or tag is a
  // programming error, and the messages OpenSSL gives for it are inscrutable.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Not a sealed value");
  }

  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(Buffer.from(bodyPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** Constant-time equality for two secrets of the same kind.
 *
 *  Here because everything else that compares a secret is in this file, and
 *  `===` on a token leaks its prefix through timing.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  // timingSafeEqual throws on a length mismatch, which would itself be a
  // signal; a length difference already means they differ.
  if (left.length !== right.length) return false;

  return timingSafeEqual(left, right);
}
