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

const {
  dotfilesFor,
  getPersonalization,
  updatePersonalization,
} = await import("./personalizationService.js");

/** What `upsert` was asked to write. */
function written(): Record<string, unknown> {
  return (upsert.mock.calls[0]?.[0] as { update: Record<string, unknown> })
    .update;
}

beforeEach(() => {
  vi.clearAllMocks();
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
    });
  });

  /** The projection is written out by hand rather than spread, so that the
   *  signing key this table is about to hold cannot leave through it. Pinned
   *  by handing back a row with a column that must not be returned. */
  it("returns only the fields it names", async () => {
    findUnique.mockResolvedValue({
      dotfilesRepo: "https://github.com/you/dotfiles",
      dotfilesTarget: null,
      dotfilesInstall: null,
      signingKey: "sealed:should-never-appear",
    });

    const result = await getPersonalization("u1");

    expect(result).not.toHaveProperty("signingKey");
    expect(JSON.stringify(result)).not.toContain("should-never-appear");
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
