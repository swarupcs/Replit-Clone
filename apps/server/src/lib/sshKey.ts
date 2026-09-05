/** Reading just enough of an OpenSSH private key to accept or refuse it.
 *
 *  plan.md §11.9. Signing a commit needs the private key inside the container,
 *  so the server has to hold one -- and holding one it cannot read is how a
 *  settings screen accepts a paste of the WRONG file and only tells anybody
 *  three weeks later, at the first commit, in git's words rather than its own.
 *
 *  Node cannot help: `crypto.createPrivateKey` does not understand OpenSSH's
 *  own private-key container at all, and throws
 *  `error:1E08010C:DECODER routines::unsupported` for a perfectly good ed25519
 *  key. So the header is parsed here. It is a short, stable, documented
 *  format (PROTOCOL.key in the OpenSSH source):
 *
 *      "openssh-key-v1\0"
 *      string  ciphername
 *      string  kdfname
 *      string  kdfoptions
 *      uint32  number of keys
 *      string  publickey1
 *      string  encrypted, padded list of private keys
 *
 *  Two facts are wanted and both are in that header, before any of the private
 *  material: whether the key is passphrase-protected, and what its public half
 *  is. The private key itself is never decoded, decrypted or interpreted here.
 *
 *  `publickey1` is already in SSH wire format, which is exactly what a `.pub`
 *  file base64-encodes -- so the public key is derived rather than asked for,
 *  and cannot be a mismatched paste. Verified against `ssh-keygen`'s own
 *  output for a real key: byte for byte identical.
 */

const MAGIC = "openssh-key-v1\0";

export interface SshPublicKey {
  /** "ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", and so on. */
  type: string;
  /** The full `ssh-ed25519 AAAA...` line, ready to paste into GitHub. */
  line: string;
}

/** Thrown for a key this server will not store, with a reason a person can act
 *  on. Every message here names what to do next. */
export class SshKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshKeyError";
  }
}

/** Reads one SSH wire-format string: a big-endian uint32 length, then that
 *  many bytes. */
function readString(
  buffer: Buffer,
  offset: number,
): { value: Buffer; next: number } {
  if (offset + 4 > buffer.length) throw new SshKeyError(TRUNCATED);

  const length = buffer.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + length;

  // Checked against the buffer rather than trusted: a length field is
  // attacker-controlled, and `subarray` would silently return something short
  // instead of failing.
  if (length > buffer.length || end > buffer.length) {
    throw new SshKeyError(TRUNCATED);
  }

  return { value: buffer.subarray(start, end), next: end };
}

const TRUNCATED =
  "That does not look like a complete private key. Paste the whole file, " +
  "including the BEGIN and END lines.";

/** Accepts an OpenSSH private key, or says why not.
 *
 *  Returns the PUBLIC half. The private key is the caller's to seal; nothing
 *  here keeps it.
 */
export function readOpenSshPrivateKey(pem: string): SshPublicKey {
  const text = pem.trim();

  if (!text.includes("BEGIN OPENSSH PRIVATE KEY")) {
    // Named specifically, because these are the two wrong files people
    // actually paste, and "invalid key" would send them looking in the wrong
    // place for both.
    if (text.startsWith("ssh-") || text.startsWith("ecdsa-")) {
      throw new SshKeyError(
        "That is a PUBLIC key. Signing needs the private one -- the file " +
          "without the .pub.",
      );
    }
    if (text.includes("BEGIN RSA PRIVATE KEY") || text.includes("BEGIN PRIVATE KEY")) {
      throw new SshKeyError(
        "That is a PEM key rather than an OpenSSH one. Convert it with " +
          "`ssh-keygen -p -f <file>`, or make a new one with " +
          "`ssh-keygen -t ed25519`.",
      );
    }
    throw new SshKeyError(
      "Expected an OpenSSH private key. Make one with `ssh-keygen -t ed25519`.",
    );
  }

  const body = text
    .replace(/-----[A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const buffer = Buffer.from(body, "base64");

  if (buffer.subarray(0, MAGIC.length).toString("utf8") !== MAGIC) {
    throw new SshKeyError(
      "That file has the right header but the wrong contents. Paste it " +
        "again, unmodified.",
    );
  }

  let offset = MAGIC.length;
  const cipher = readString(buffer, offset);
  offset = cipher.next;
  const kdf = readString(buffer, offset);
  offset = kdf.next;
  const kdfOptions = readString(buffer, offset);
  offset = kdfOptions.next;

  // The one refusal that matters operationally. A passphrase-protected key
  // cannot be used unattended: `ssh-keygen -Y sign` would ask for it, there is
  // nobody at the other end of the exec to answer, and the commit would hang
  // rather than fail. Refusing it here, with the command that fixes it, is far
  // better than discovering it at the first commit.
  if (cipher.value.toString("utf8") !== "none") {
    throw new SshKeyError(
      "That key has a passphrase, and nothing here can be asked for one. " +
        "Use a key without one -- `ssh-keygen -p -f <file>` removes it, and " +
        "a key used only for signing is a reasonable place to have none.",
    );
  }

  if (offset + 4 > buffer.length) throw new SshKeyError(TRUNCATED);
  const keyCount = buffer.readUInt32BE(offset);
  offset += 4;
  if (keyCount !== 1) {
    throw new SshKeyError("Expected a file holding exactly one key.");
  }

  const publicSection = readString(buffer, offset);
  const publicKey = publicSection.value;

  // The private section is read only to confirm it is THERE and whole.
  //
  // Not decoded, not decrypted, not interpreted -- but a file cut short after
  // the header parses perfectly and yields a correct public key, because the
  // public half genuinely lives in the header. Storing that would produce a
  // key that works everywhere except at the one moment it is used, which is
  // precisely the failure this parser exists to prevent. A test found it.
  const privateSection = readString(buffer, publicSection.next);
  if (privateSection.value.length === 0) throw new SshKeyError(TRUNCATED);

  // The type is the first wire string INSIDE the public key blob, and it has
  // to be read rather than assumed: it is what names the algorithm in the
  // `.pub` line, and an ed25519 line claiming to be RSA would be rejected by
  // everything downstream.
  const type = readString(publicKey, 0).value.toString("utf8");
  if (!type) throw new SshKeyError(TRUNCATED);

  return { type, line: `${type} ${publicKey.toString("base64")}` };
}
