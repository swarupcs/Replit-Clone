import { beforeEach, describe, expect, it, vi } from "vitest";

/** One account's dotfiles settings.
 *
 *  The rules about WHAT is a valid repository live in `dotfiles.test.ts`, next
 *  to the clone they protect. What is left here is the part a settings
 *  endpoint gets wrong: telling "leave this alone" apart from "clear this".
 *  Get that wrong in one direction and the panel is write-only -- you can set
 *  dotfiles and never stop using them. Get it wrong in the other and saving
 *  one field silently wipes the other two.
 */

const findUnique = vi.hoisted(() => vi.fn());
const upsert = vi.hoisted(() => vi.fn());
vi.mock("../lib/prisma.js", () => ({
  prisma: { userPersonalization: { findUnique, upsert } },
}));

/** The box is stubbed and the KEY PARSER is not.
 *
 *  Encryption is `secretBox`'s own business and it has its own tests; what
 *  matters here is that the value written to the column went through it. The
 *  parser is real because the refusals are the interesting part, and stubbing
 *  it would only prove the service calls something.
 */
vi.mock("../lib/secretBox.js", () => ({
  isSecretBoxConfigured: () => configured,
  seal: (value: string) => `sealed(${value.slice(0, 8)})`,
  open: (value: string) => {
    const match = /^sealed\((.*)\)$/.exec(value);
    if (!match) throw new Error("not sealed under this key");
    return match[1] ?? "";
  },
}));

let configured = true;

const {
  dotfilesFor,
  getPersonalization,
  signingFor,
  updatePersonalization,
} = await import("./personalizationService.js");

const { ED25519, ED25519_PASSPHRASE, ED25519_PUBLIC } = await import(
  "../lib/sshKey.fixtures.js"
);

/** The comment is not part of the key material, so it is not part of what the
 *  parser derives. */
const PUBLIC_LINE = ED25519_PUBLIC.split(" ").slice(0, 2).join(" ");

/** What `upsert` was asked to write. */
function written(): Record<string, unknown> {
  return (upsert.mock.calls[0]?.[0] as { update: Record<string, unknown> })
    .update;
}

beforeEach(() => {
  vi.clearAllMocks();
  configured = true;
  findUnique.mockResolvedValue(null);
  upsert.mockResolvedValue(undefined);
});

describe("reading", () => {
  /** Every account that existed before this table did has no row, and that is
   *  "nothing set" rather than an error. */
  it("gives an account with no row the defaults", async () => {
    expect(await getPersonalization("u1")).toEqual({
      dotfilesRepo: null,
      dotfilesTarget: null,
      dotfilesInstall: null,
      signingKeyPublic: null,
      hasSigningKey: false,
      signCommits: false,
    });
  });

  /** The projection is written out by hand rather than spread, so the signing
   *  private key cannot leave through it. Pinned by handing back a row that
   *  carries one. */
  it("never returns the private key, however it arrives", async () => {
    findUnique.mockResolvedValue({
      dotfilesRepo: "https://github.com/you/dotfiles",
      dotfilesTarget: null,
      dotfilesInstall: null,
      signingKeyPublic: PUBLIC_LINE,
      signCommits: true,
      signingKey: "sealed:should-never-appear",
    });

    const result = await getPersonalization("u1");

    expect(result).not.toHaveProperty("signingKey");
    expect(JSON.stringify(result)).not.toContain("should-never-appear");
    // What IS returned: that there is one, and its public half.
    expect(result.hasSigningKey).toBe(true);
    expect(result.signingKeyPublic).toBe(PUBLIC_LINE);
  });
});

describe("what the container layer asks for", () => {
  /** Null rather than a settings object with an empty URL, so a caller cannot
   *  mistake "no dotfiles" for "dotfiles at the empty string". */
  it("is null when no repository is set", async () => {
    findUnique.mockResolvedValue({
      dotfilesRepo: null,
      dotfilesTarget: "~/dots",
      dotfilesInstall: null,
    });

    expect(await dotfilesFor("u1")).toBeNull();
  });

  it("is null for an account with no row at all", async () => {
    expect(await dotfilesFor("u1")).toBeNull();
  });

  it("carries the target and install command through", async () => {
    findUnique.mockResolvedValue({
      dotfilesRepo: "https://github.com/you/dotfiles",
      dotfilesTarget: "~/.dots",
      dotfilesInstall: "./install.sh",
    });

    expect(await dotfilesFor("u1")).toEqual({
      repo: "https://github.com/you/dotfiles",
      target: "~/.dots",
      install: "./install.sh",
    });
  });
});

describe("writing", () => {
  /** The one that makes the panel two-way. */
  it("treats an empty string as a request to clear", async () => {
    await updatePersonalization("u1", { dotfilesRepo: "" });

    expect(written()).toEqual({ dotfilesRepo: null });
  });

  it("treats an explicit null the same way", async () => {
    await updatePersonalization("u1", { dotfilesTarget: null });

    expect(written()).toEqual({ dotfilesTarget: null });
  });

  /** An absent field is not mentioned in the write at all, so saving one
   *  setting cannot wipe the other two. */
  it("leaves out what the request did not mention", async () => {
    await updatePersonalization("u1", {
      dotfilesRepo: "https://github.com/you/dotfiles",
    });

    const data = written();
    expect(Object.keys(data)).toEqual(["dotfilesRepo"]);
  });

  it("trims what it stores", async () => {
    await updatePersonalization("u1", {
      dotfilesRepo: "  https://github.com/you/dotfiles  ",
    });

    expect(written().dotfilesRepo).toBe("https://github.com/you/dotfiles");
  });

  /** Refused before it reaches the database, and with the reason the clone
   *  itself would have given -- the two share one function so they cannot
   *  disagree about what is allowed. */
  it("refuses a URL the clone would refuse, and writes nothing", async () => {
    await expect(
      updatePersonalization("u1", {
        dotfilesRepo: "ssh://git@github.com/you/dotfiles",
      }),
    ).rejects.toThrow(/authenticate as the server/);

    expect(upsert).not.toHaveBeenCalled();
  });

  /** The target that would land in the user's repository. */
  it("refuses the project directory as a target", async () => {
    await expect(
      updatePersonalization("u1", { dotfilesTarget: "/home/sandbox/app" }),
    ).rejects.toThrow(/project itself/);

    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses an install command long enough to be a program", async () => {
    await expect(
      updatePersonalization("u1", { dotfilesInstall: "x".repeat(501) }),
    ).rejects.toThrow(/500/);
  });
});

describe("the signing key", () => {
  it("seals the private half and stores the public half in the clear", async () => {
    await updatePersonalization("u1", { signingKey: ED25519 });

    const data = written();
    expect(data.signingKeyPublic).toBe(PUBLIC_LINE);
    expect(String(data.signingKey)).toMatch(/^sealed\(/);
    // The plaintext key never reaches the column.
    expect(String(data.signingKey)).not.toContain("OPENSSH PRIVATE KEY");
  });

  /** Refused at the point of paste rather than at the first commit, where it
   *  would HANG waiting for a passphrase nobody can type. */
  it("refuses a passphrase-protected key before storing it", async () => {
    await expect(
      updatePersonalization("u1", { signingKey: ED25519_PASSPHRASE }),
    ).rejects.toThrow(/passphrase/);

    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses a pasted public key, and says which file to use", async () => {
    await expect(
      updatePersonalization("u1", { signingKey: ED25519_PUBLIC }),
    ).rejects.toThrow(/PUBLIC key/);
  });

  /** A deployment with no SECRET_ENCRYPTION_KEY cannot keep this safely, and
   *  storing it in the clear rather than saying so is the one outcome that
   *  must not happen. */
  it("refuses to store a key it cannot seal", async () => {
    configured = false;

    await expect(
      updatePersonalization("u1", { signingKey: ED25519 }),
    ).rejects.toThrow(/SECRET_ENCRYPTION_KEY/);

    expect(upsert).not.toHaveBeenCalled();
  });

  /** Both halves go together, or `hasSigningKey` -- which is read off the
   *  public one -- would start lying. */
  it("clears both halves together, and stops signing", async () => {
    await updatePersonalization("u1", { signingKey: "" });

    expect(written()).toEqual({
      signingKey: null,
      signingKeyPublic: null,
      signCommits: false,
    });
  });

  /** "Signing is on" with nothing to sign with is a state the account screen
   *  could only describe as a bug. */
  it("will not turn signing on without a key", async () => {
    await expect(
      updatePersonalization("u1", { signCommits: true }),
    ).rejects.toThrow(/Add a signing key/);
  });

  it("turns signing on in the same request that adds the key", async () => {
    await updatePersonalization("u1", {
      signingKey: ED25519,
      signCommits: true,
    });

    expect(written().signCommits).toBe(true);
  });

  /** Off without deleting: somebody pausing signing should not have to paste
   *  their key again to resume. */
  it("turns signing off without touching the key", async () => {
    findUnique.mockResolvedValue({ signingKeyPublic: PUBLIC_LINE });

    await updatePersonalization("u1", { signCommits: false });

    expect(written()).toEqual({ signCommits: false });
  });
});

describe("what the git service asks for", () => {
  /** Two conditions, and they are separate on purpose: a key that exists is
   *  not consent to sign with it. */
  it("is null when signing is off, even with a key stored", async () => {
    findUnique.mockResolvedValue({
      signingKey: "sealed(x)",
      signingKeyPublic: PUBLIC_LINE,
      signCommits: false,
    });

    expect(await signingFor("u1")).toBeNull();
  });

  it("is null when signing is on but no key was ever added", async () => {
    findUnique.mockResolvedValue({
      signingKey: null,
      signingKeyPublic: null,
      signCommits: true,
    });

    expect(await signingFor("u1")).toBeNull();
  });

  it("opens the key when both are true", async () => {
    findUnique.mockResolvedValue({
      signingKey: "sealed(PRIVATE)",
      signingKeyPublic: PUBLIC_LINE,
      signCommits: true,
    });

    expect(await signingFor("u1")).toEqual({
      privateKey: "PRIVATE",
      publicKey: PUBLIC_LINE,
    });
  });

  /** Sealed under a key this deployment no longer has. Committing UNSIGNED is
   *  the right failure: refusing to commit at all would turn a configuration
   *  change nobody connected to git into a reason work cannot be saved. */
  it("commits unsigned rather than failing when the box will not open", async () => {
    findUnique.mockResolvedValue({
      signingKey: "not-openable",
      signingKeyPublic: PUBLIC_LINE,
      signCommits: true,
    });

    expect(await signingFor("u1")).toBeNull();
  });
});
