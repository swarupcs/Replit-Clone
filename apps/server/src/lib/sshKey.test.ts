import { describe, expect, it } from "vitest";
import { readOpenSshPrivateKey, SshKeyError } from "./sshKey.js";
import {
  ECDSA,
  ECDSA_PUBLIC,
  ED25519,
  ED25519_PASSPHRASE,
  ED25519_PUBLIC,
} from "./sshKey.fixtures.js";

/** Reading an OpenSSH private key.
 *
 *  The whole value of this parser is that it agrees with OpenSSH, so the
 *  inputs are real keys from `ssh-keygen` and the expected public halves are
 *  the `.pub` files it wrote beside them. A hand-built fixture would only ever
 *  prove the parser agrees with itself.
 *
 *  Two of these tests are the reason the parser exists at all rather than the
 *  key being taken on trust: a passphrase-protected key would HANG the first
 *  commit rather than fail it, and a pasted `.pub` would be stored happily and
 *  fail three weeks later in git's words.
 */

/** The comment is not part of what is derived -- it lives outside the key
 *  material -- so the first two fields are what has to match. */
function withoutComment(line: string): string {
  return line.split(" ").slice(0, 2).join(" ");
}

describe("keys it accepts", () => {
  /** Byte for byte what `ssh-keygen` put in the .pub file. */
  it("derives the public half of an ed25519 key", () => {
    const key = readOpenSshPrivateKey(ED25519);

    expect(key.type).toBe("ssh-ed25519");
    expect(key.line).toBe(withoutComment(ED25519_PUBLIC));
  });

  /** The type is read out of the blob rather than assumed, so a key that is
   *  not ed25519 has to come back saying so. */
  it("reads the algorithm rather than assuming one", () => {
    const key = readOpenSshPrivateKey(ECDSA);

    expect(key.type).toBe("ecdsa-sha2-nistp256");
    expect(key.line).toBe(withoutComment(ECDSA_PUBLIC));
  });

  it("does not mind surrounding whitespace from a paste", () => {
    expect(readOpenSshPrivateKey(`\n  ${ED25519}\n\n`).type).toBe(
      "ssh-ed25519",
    );
  });
});

describe("keys it refuses, and what it says", () => {
  /** The operationally important one. `ssh-keygen -Y sign` would ask for the
   *  passphrase, there is nobody at the other end of a `docker exec` to answer,
   *  and the commit would hang rather than fail. The message carries the
   *  command that fixes it. */
  it("refuses a passphrase-protected key, because nothing can be asked", () => {
    expect(() => readOpenSshPrivateKey(ED25519_PASSPHRASE)).toThrow(
      /passphrase/,
    );
    expect(() => readOpenSshPrivateKey(ED25519_PASSPHRASE)).toThrow(
      /ssh-keygen -p/,
    );
  });

  /** The most common wrong paste by a distance, and the one where a generic
   *  "invalid key" sends somebody looking in exactly the wrong place. */
  it("tells somebody who pasted the .pub file which file to use", () => {
    expect(() => readOpenSshPrivateKey(ED25519_PUBLIC)).toThrow(/PUBLIC key/);
    expect(() => readOpenSshPrivateKey(ED25519_PUBLIC)).toThrow(/\.pub/);
  });

  it("names the conversion for an old PEM key", () => {
    expect(() =>
      readOpenSshPrivateKey(
        "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----",
      ),
    ).toThrow(/ssh-keygen -p/);
  });

  it("refuses something that is not a key at all", () => {
    expect(() => readOpenSshPrivateKey("hello")).toThrow(SshKeyError);
    expect(() => readOpenSshPrivateKey("")).toThrow(/ssh-keygen -t ed25519/);
  });

  /** A length field inside the file is attacker-controlled. Reading past the
   *  end has to be an error with a message, not a short `subarray` that
   *  quietly yields a wrong public key. */
  it("refuses a truncated key rather than returning half of one", () => {
    const half = ED25519.slice(0, Math.floor(ED25519.length / 2));

    expect(() =>
      readOpenSshPrivateKey(`${half}\n-----END OPENSSH PRIVATE KEY-----`),
    ).toThrow(SshKeyError);
  });

  /** The header is right and the body is not: worth its own message, because
   *  "paste it again unmodified" is the actual fix and no other message here
   *  says it. */
  it("refuses a file with the right header and the wrong contents", () => {
    expect(() =>
      readOpenSshPrivateKey(
        "-----BEGIN OPENSSH PRIVATE KEY-----\nbm90IGEga2V5\n-----END OPENSSH PRIVATE KEY-----",
      ),
    ).toThrow(/unmodified/);
  });
});
