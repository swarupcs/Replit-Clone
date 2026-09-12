import { describe, expect, it } from "vitest";
import {
  authorizedKeysFile,
  parseSshPublicKey,
  parseSshPublicKeys,
} from "./sshPublicKey.js";

/** A real ed25519 public key, built the way OpenSSH does: the wire format is
 *  string(type) + string(key), so the blob's own first field repeats the type.
 *  Constructed rather than pasted so the test says where every byte came
 *  from. */
function ed25519(seed = 7): string {
  const type = Buffer.from("ssh-ed25519", "ascii");
  const key = Buffer.alloc(32, seed);

  const blob = Buffer.concat([
    lengthPrefixed(type),
    lengthPrefixed(key),
  ]);
  return blob.toString("base64");
}

function lengthPrefixed(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

const KEY = `ssh-ed25519 ${ed25519()} me@laptop`;

describe("accepting a public key", () => {
  it("takes an ordinary one and keeps its comment", () => {
    const key = parseSshPublicKey(KEY);
    expect(key.type).toBe("ssh-ed25519");
    expect(key.comment).toBe("me@laptop");
  });

  it("takes one with no comment, which is legal and common", () => {
    expect(parseSshPublicKey(`ssh-ed25519 ${ed25519()}`).comment).toBe("");
  });

  it("fingerprints it the way ssh-keygen does", () => {
    // SHA256 of the raw blob, base64, padding stripped. Computed rather than
    // asked for, so what a panel shows can be compared against `ssh-keygen -lf`
    // without trusting the panel.
    const key = parseSshPublicKey(KEY);
    expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(key.fingerprint.endsWith("=")).toBe(false);
  });

  it("gives the same fingerprint whatever the comment says", () => {
    const a = parseSshPublicKey(`ssh-ed25519 ${ed25519()} one@host`);
    const b = parseSshPublicKey(`ssh-ed25519 ${ed25519()} another@host`);
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});

describe("refusing what must not reach authorized_keys", () => {
  it("refuses a line carrying an option list", () => {
    // `command=` pins a forced command and `environment=` sets variables in
    // the session. Neither is something a paste box should do by accident.
    expect(() =>
      parseSshPublicKey(`command="/bin/sh" ssh-ed25519 ${ed25519()}`),
    ).toThrow(/not accepted here/);
  });

  it("refuses an embedded newline, which would be a second line", () => {
    expect(() => parseSshPublicKey(`ssh-ed25519 ${ed25519()}\nssh-rsa AAAA`)).toThrow(
      /one key per line/,
    );
  });

  it("names a private key as a private key, and says to rotate it", () => {
    // "Invalid key" would send somebody to look at the key rather than at
    // which file they opened.
    expect(() =>
      parseSshPublicKey("-----BEGIN OPENSSH PRIVATE KEY-----"),
    ).toThrow(/PRIVATE key.*rotate/s);
  });

  it("refuses a key type OpenSSH itself has dropped", () => {
    // ssh-dss was removed in OpenSSH 9.8, so storing one would store a key
    // that can never log in.
    expect(() => parseSshPublicKey(`ssh-dss ${ed25519()}`)).toThrow(/not a key type/);
  });

  it("refuses a line whose type and key disagree", () => {
    // Assembled by hand or by something that got it wrong. OpenSSH would
    // reject it far later with a far worse message.
    expect(() => parseSshPublicKey(`ssh-rsa ${ed25519()}`)).toThrow(
      /says ssh-rsa but the key inside it is ssh-ed25519/,
    );
  });

  it("refuses base64 that is not base64", () => {
    expect(() => parseSshPublicKey("ssh-ed25519 not-base-64!!")).toThrow(
      /not valid base64/,
    );
  });

  it("refuses something absurdly long", () => {
    expect(() => parseSshPublicKey(`ssh-ed25519 ${"A".repeat(9000)}`)).toThrow(
      /too long/,
    );
  });
});

describe("a whole paste", () => {
  it("drops blank lines and hash comments, because people paste the file", () => {
    const keys = parseSshPublicKeys(["", "# work laptop", KEY, "  "]);
    expect(keys).toHaveLength(1);
  });

  it("collapses the same key listed twice under different comments", () => {
    // One key. Storing it twice means removing it once does nothing.
    const keys = parseSshPublicKeys([
      `ssh-ed25519 ${ed25519()} home`,
      `ssh-ed25519 ${ed25519()} work`,
    ]);
    expect(keys).toHaveLength(1);
  });

  it("keeps two genuinely different keys", () => {
    expect(
      parseSshPublicKeys([`ssh-ed25519 ${ed25519(1)}`, `ssh-ed25519 ${ed25519(2)}`]),
    ).toHaveLength(2);
  });

  it("refuses the whole paste when one line is bad", () => {
    // Six keys with one typo store none of them rather than five.
    expect(() => parseSshPublicKeys([KEY, "nonsense"])).toThrow();
  });
});

describe("the file itself", () => {
  it("says it is generated, so nobody edits it in place", () => {
    const file = authorizedKeysFile(parseSshPublicKeys([KEY]));
    expect(file).toMatch(/^# Generated/);
    expect(file).toContain("account screen");
  });

  it("writes one key per line and ends with a newline", () => {
    const file = authorizedKeysFile(parseSshPublicKeys([KEY]));
    expect(file.endsWith("\n")).toBe(true);
    expect(file.split("\n").filter((line) => line.startsWith("ssh-"))).toHaveLength(1);
  });

  it("writes the reassembled line, not the raw input", () => {
    // Whatever lands in the file is exactly what was validated -- extra
    // whitespace in the paste does not survive into it.
    const file = authorizedKeysFile(parseSshPublicKeys([`ssh-ed25519   ${ed25519()}   me`]));
    expect(file).toContain(`ssh-ed25519 ${ed25519()} me`);
  });
});
