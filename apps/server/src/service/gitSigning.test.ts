import { beforeEach, describe, expect, it, vi } from "vitest";

/** Signing a commit. plan.md §11.9.
 *
 *  What a unit test can hold and what it cannot are unusually far apart here.
 *  It cannot tell you the signature verifies -- that took a real container, a
 *  real `ssh-keygen` and `git log --show-signature`, which is where this was
 *  actually proven. What it CAN hold is everything that would quietly stop
 *  being true afterwards: that the key never reaches argv, that the temporary
 *  file is removed whatever happens, that an unsigned commit still takes the
 *  old path, and that a failure to sign says what became of the work.
 */

const execCapture = vi.hoisted(() => vi.fn());
vi.mock("../containers/execCapture.js", () => ({ execCapture }));
vi.mock("../containers/containerManager.js", () => ({
  ensureContainer: vi.fn(() => Promise.resolve({ id: "container" })),
}));

const { commit, signedCommitScript } = await import("./gitService.js");

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const AUTHOR = { name: "swarup", email: "swarup@example.test" };
const SIGNING = {
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET\n-----END OPENSSH PRIVATE KEY-----",
  publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA",
};

/** The FIRST exec, which is the commit itself.
 *
 *  Not the last: `commit` calls `history` afterwards, so the last exec is a
 *  `git log` and asserting against it would pass while testing nothing. */
function commitCall() {
  const call = execCapture.mock.calls[0];
  return {
    argv: (call?.[1] ?? []) as string[],
    options: (call?.[2] ?? {}) as { env?: Record<string, string> },
  };
}

/** `commit` calls `history` afterwards, which runs `git log`. Both succeed. */
beforeEach(() => {
  vi.clearAllMocks();
  execCapture.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
});

describe("the script", () => {
  /** The same property `pushRemote` holds for its token, and for the same
   *  reason: argv is world-readable through /proc, an environment is not. */
  it("names no secret, and no user text, anywhere in itself", () => {
    const script = signedCommitScript();

    expect(script).toContain('"$RC_SIGNING_KEY"');
    expect(script).toContain('"$RC_MESSAGE"');
    expect(script).toContain('"$RC_NAME"');
    expect(script).toContain('"$RC_EMAIL"');
  });

  /** Before the key is written, not after. A chmod afterwards leaves a window
   *  in which the key is world-readable inside the container. */
  it("sets the umask before it writes anything", () => {
    const script = signedCommitScript();

    expect(script.indexOf("umask 077")).toBeLessThan(script.indexOf("printf"));
  });

  /** The commit can fail, and usually the interesting failures are the ones
   *  where it does. A private key left behind in a container that goes on
   *  running is the failure that matters. */
  it("removes the key whether the commit worked or not", () => {
    expect(signedCommitScript()).toContain(
      `trap 'rm -rf "$d"' EXIT INT TERM`,
    );
  });

  /** /tmp, not the workspace. A key written under /home/sandbox/app would be
   *  in the user's project, on the host's disk, and in `git status`. */
  it("writes the key outside the bind mount", () => {
    const script = signedCommitScript();

    expect(script).toContain("mktemp -d");
    expect(script).not.toContain("/home/sandbox/app");
  });

  /** `-c` rather than `git config`: a `user.signingkey` written into the
   *  repository would outlive the temporary directory it points at, and break
   *  every later commit made outside this server. */
  it("never writes to the repository's own config", () => {
    const script = signedCommitScript();

    expect(script).toContain("-c user.signingkey=");
    expect(script).not.toContain("git config");
  });

  /** ssh-keygen looks for the public half beside the private one rather than
   *  deriving it, so the .pub is not decoration. */
  it("writes the public half beside the private one", () => {
    expect(signedCommitScript()).toContain('"$d/key.pub"');
  });
});

describe("committing", () => {
  it("passes the key through the environment, never through argv", async () => {
    await commit(PROJECT, "a message", AUTHOR, SIGNING);

    const { argv, options } = commitCall();

    expect(options.env?.RC_SIGNING_KEY).toBe(SIGNING.privateKey);
    expect(argv.join(" ")).not.toContain("SECRET");
  });

  /** The message is not interpolated either, so one containing a quote, a
   *  newline or a `$(...)` is text rather than a command. */
  it("passes the message through the environment too", async () => {
    const message = `fix: don't $(touch /pwned) "quote" it\nsecond line`;

    await commit(PROJECT, message, AUTHOR, SIGNING);

    const { argv, options } = commitCall();
    expect(options.env?.RC_MESSAGE).toBe(message);
    // Not `rm -rf`, which the script's own `trap` legitimately contains --
    // asserting on that would have failed for the right reason and the wrong
    // one at once.
    expect(argv.join(" ")).not.toContain("touch /pwned");
  });

  /** Signing is opt-in, and the unsigned path is what every commit before this
   *  took. It must not have moved. */
  it("takes the plain path when there is no signing identity", async () => {
    await commit(PROJECT, "a message", AUTHOR, null);

    const { argv } = commitCall();

    expect(argv[0]).toBe("git");
    expect(argv).toContain("commit");
    expect(argv).toContain(`user.email=${AUTHOR.email}`);
  });

  it("still refuses an empty message", async () => {
    await expect(commit(PROJECT, "   ", AUTHOR, SIGNING)).rejects.toThrow(
      /needs a message/,
    );
    expect(execCapture).not.toHaveBeenCalled();
  });

  /** git says "gpg failed to sign the data" whichever backend it used, naming
   *  a tool that is not involved. */
  it("translates git's confusing signing failure", async () => {
    execCapture.mockResolvedValue({
      stdout: "",
      stderr: "error: gpg failed to sign the data\nfatal: failed to write commit object",
      exitCode: 128,
    });

    await expect(commit(PROJECT, "m", AUTHOR, SIGNING)).rejects.toThrow(
      /still staged/,
    );
  });

  /** The other phrasing, and the one seen in a real container when the image
   *  had no openssh-client: git names a symptom two steps downstream. */
  it("translates the missing-ssh-keygen failure as well", async () => {
    execCapture.mockResolvedValue({
      stdout: "",
      stderr:
        "error: cannot run ssh-keygen: No such file or directory\nfatal: failed to write commit object",
      exitCode: 128,
    });

    await expect(commit(PROJECT, "m", AUTHOR, SIGNING)).rejects.toThrow(
      /could not be signed/,
    );
  });

  /** The same words out of an UNSIGNED commit are not a signing problem, and
   *  saying they are would send somebody to a settings screen that has nothing
   *  to do with it. */
  it("does not blame signing for a failure on an unsigned commit", async () => {
    execCapture.mockResolvedValue({
      stdout: "",
      stderr: "fatal: failed to write commit object",
      exitCode: 128,
    });

    await expect(commit(PROJECT, "m", AUTHOR, null)).rejects.toThrow(
      /failed to write commit object/,
    );
  });

  /** Nothing staged is still nothing staged, signed or not. */
  it("keeps saying when there is nothing to commit", async () => {
    execCapture.mockResolvedValue({
      stdout: "nothing to commit, working tree clean",
      stderr: "",
      exitCode: 1,
    });

    await expect(commit(PROJECT, "m", AUTHOR, SIGNING)).rejects.toThrow(
      /Nothing staged/,
    );
  });
});
