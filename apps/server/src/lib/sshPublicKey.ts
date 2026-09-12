import { createHash } from "node:crypto";
import type { SshKey } from "@replit-clone/shared";

/** Reading an `authorized_keys` line well enough to accept or refuse it.
 *  plan.md §10.1 Route C.
 *
 *  The sibling of `sshKey.ts`, which reads a PRIVATE key so a container can
 *  sign a commit. This reads a PUBLIC one so a person can log in, and the two
 *  are kept apart on purpose: one must never be read back and the other must
 *  always be.
 *
 *  **Why parse at all rather than store the string.** Whatever is accepted
 *  here is written into a file that decides who may open somebody's workspace.
 *  A line with a newline in it is two lines in that file; a line beginning with
 *  `command=` or `environment=` is an OpenSSH *option* list, which can pin a
 *  forced command or set variables in the session. Neither is something a
 *  paste box should be able to do by accident, so this accepts exactly one
 *  shape: type, base64 blob, optional comment.
 *
 *  The fingerprint is OpenSSH's own: base64 of the SHA-256 of the raw key
 *  blob, `=` padding stripped, prefixed `SHA256:`. It is computed rather than
 *  asked for so that what the panel shows can be compared against
 *  `ssh-keygen -lf` on the machine the key came from.
 */

/** The key types OpenSSH will actually accept in 2026, minus the ones nobody
 *  should be adding now. `ssh-dss` is absent deliberately: OpenSSH disabled
 *  DSA by default years ago and removed it entirely in 9.8, so accepting one
 *  here would store a key that can never log in. */
const KEY_TYPES = new Set([
  "ssh-ed25519",
  "sk-ssh-ed25519@openssh.com",
  "ssh-rsa",
  "rsa-sha2-256",
  "rsa-sha2-512",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]);

/** Long enough for any real key, short enough that a paste of the wrong file
 *  is refused rather than stored. A 4096-bit RSA key is about 720 base64
 *  characters. */
const MAX_LINE = 4096;

export class InvalidSshKeyError extends Error {}

function fingerprint(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** Parses one line, or throws with a message that names what is wrong with
 *  the line rather than what is wrong with the parser. */
export function parseSshPublicKey(raw: string): SshKey {
  const line = raw.trim();

  if (line === "") throw new InvalidSshKeyError("That line is empty");
  if (line.length > MAX_LINE) {
    throw new InvalidSshKeyError("That is too long to be a public key");
  }
  // A newline inside one "line" is two lines in authorized_keys, and the
  // second one is not something anybody reviewed.
  if (/[\r\n]/.test(line)) {
    throw new InvalidSshKeyError("Add one key per line");
  }

  const parts = line.split(/\s+/);
  const [type, blob, ...rest] = parts;

  if (type === undefined || blob === undefined) {
    throw new InvalidSshKeyError(
      "A public key looks like `ssh-ed25519 AAAA... you@machine`",
    );
  }

  if (!KEY_TYPES.has(type)) {
    // Catches the two common wrong pastes by name, because "invalid key" sends
    // somebody looking at the key rather than at which file they opened.
    if (line.startsWith("-----BEGIN")) {
      throw new InvalidSshKeyError(
        "That is a PRIVATE key. Paste the .pub file instead, and rotate that key",
      );
    }
    if (type.includes("=")) {
      throw new InvalidSshKeyError(
        "Options such as command= or environment= are not accepted here",
      );
    }
    throw new InvalidSshKeyError(`${type} is not a key type this accepts`);
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) {
    throw new InvalidSshKeyError("The key itself is not valid base64");
  }

  const decoded = Buffer.from(blob, "base64");
  if (decoded.length < 16) {
    throw new InvalidSshKeyError("The key itself is too short to be real");
  }

  // The blob's own first field repeats the type. A mismatch means the line was
  // assembled by hand or by something that got it wrong, and OpenSSH would
  // reject it later with a far less helpful message.
  const nameLength = decoded.readUInt32BE(0);
  if (nameLength > 64 || decoded.length < 4 + nameLength) {
    throw new InvalidSshKeyError("The key itself is malformed");
  }
  const embedded = decoded.subarray(4, 4 + nameLength).toString("ascii");
  if (embedded !== type) {
    throw new InvalidSshKeyError(
      `That line says ${type} but the key inside it is ${embedded}`,
    );
  }

  const comment = rest.join(" ");

  return {
    // Rebuilt from the parsed parts rather than passed through, so whatever is
    // written to authorized_keys is exactly what was validated.
    line: comment === "" ? `${type} ${blob}` : `${type} ${blob} ${comment}`,
    type,
    comment,
    fingerprint: fingerprint(decoded),
  };
}

/** Parses a whole paste. Blank lines and `#` comments are dropped rather than
 *  refused, because people paste the file, not the line. */
export function parseSshPublicKeys(lines: readonly string[]): SshKey[] {
  const keys: SshKey[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const key = parseSshPublicKey(trimmed);
    // By fingerprint, not by line: the same key with two different comments is
    // one key, and storing it twice means removing it once does nothing.
    if (seen.has(key.fingerprint)) continue;
    seen.add(key.fingerprint);
    keys.push(key);
  }

  return keys;
}

/** The file itself. Not just a join: the header says where it came from, so
 *  somebody who finds it inside a container knows it is generated and that
 *  editing it will not survive the next start. */
export function authorizedKeysFile(keys: readonly SshKey[]): string {
  const header = [
    "# Generated. Managed by this platform; edits here are lost on restart.",
    "# Add or remove keys on the account screen instead.",
  ];
  return [...header, ...keys.map((key) => key.line), ""].join("\n");
}
