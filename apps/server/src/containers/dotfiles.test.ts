import { beforeEach, describe, expect, it, vi } from "vitest";

/** Dotfiles: what this server will and will not clone, and what it runs.
 *
 *  Three groups, and they are three different kinds of risk. The URL rules
 *  keep the SERVER's credentials out of the clone. The target rules keep the
 *  clone out of the user's PROJECT. The script is the part that actually runs
 *  inside somebody's container, so what it does when things are missing or
 *  already there is the whole of whether this is safe to run on every start.
 */

const execCapture = vi.hoisted(() => vi.fn());
vi.mock("./execCapture.js", () => ({ execCapture }));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  applyDotfiles,
  dotfilesScript,
  resolveTarget,
  shellQuote,
  validateRepoUrl,
} = await import("./dotfiles.js");

const container = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  execCapture.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
});

describe("which repositories are clonable", () => {
  it("takes an ordinary https URL", () => {
    expect(validateRepoUrl("  https://github.com/you/dotfiles  ")).toBe(
      "https://github.com/you/dotfiles",
    );
  });

  /** The important one. An ssh:// clone authenticates with whatever key the
   *  SERVER has, which is not the user's identity and may be a deploy key with
   *  real access to something. */
  it("refuses ssh, which would authenticate as the server", () => {
    expect(() => validateRepoUrl("ssh://git@github.com/you/dotfiles")).toThrow(
      /authenticate as the server/,
    );
    expect(() => validateRepoUrl("git@github.com:you/dotfiles.git")).toThrow();
  });

  it("refuses file://, which would clone out of the server's own disk", () => {
    expect(() => validateRepoUrl("file:///etc")).toThrow(/https/);
  });

  /** A token in the URL would sit in a column in the clear. */
  it("refuses credentials embedded in the URL", () => {
    expect(() =>
      validateRepoUrl("https://user:ghp_secret@github.com/you/dotfiles"),
    ).toThrow(/credentials/);
  });

  it("refuses something that could be read as a git option", () => {
    expect(() => validateRepoUrl("--upload-pack=touch /tmp/x")).toThrow();
  });

  it("refuses an empty value rather than storing one", () => {
    expect(() => validateRepoUrl("   ")).toThrow();
  });
});

describe("where they are allowed to land", () => {
  it("defaults to ~/dotfiles when nothing is set", () => {
    expect(resolveTarget(null)).toBe("/home/sandbox/dotfiles");
    expect(resolveTarget("  ")).toBe("/home/sandbox/dotfiles");
  });

  it("expands ~/ the way the setting it copies does", () => {
    expect(resolveTarget("~/.config/mine")).toBe(
      "/home/sandbox/.config/mine",
    );
  });

  /** The one that would end up in somebody's commit. /home/sandbox/app is the
   *  bind mount, so a clone there lands in the project, on the host disk, and
   *  against the account's disk quota. */
  it("refuses the project directory, which is the bind mount", () => {
    expect(() => resolveTarget("/home/sandbox/app")).toThrow(/project itself/);
    expect(() => resolveTarget("/home/sandbox/app/tools")).toThrow(
      /project itself/,
    );
  });

  it("refuses a path that climbs out with ..", () => {
    expect(() => resolveTarget("~/../../etc")).toThrow(/\.\./);
  });

  it("refuses anywhere outside the home directory", () => {
    expect(() => resolveTarget("/etc/dotfiles")).toThrow(/under/);
    expect(() => resolveTarget("relative/path")).toThrow(/absolute/);
  });

  /** Cloning straight into ~ would make the home directory a git working
   *  tree, which is a thing people do deliberately and nothing here can undo
   *  safely -- `rm -rf` on the target is the first line of the script. */
  it("refuses the home directory itself", () => {
    expect(() => resolveTarget("/home/sandbox")).toThrow(/directory of its own/);
    expect(() => resolveTarget("~/")).toThrow(/directory of its own/);
  });
});

describe("the script that runs in the container", () => {
  /** Without this a private or misspelled repository makes git sit waiting for
   *  a username nobody can type, and the clone burns the whole budget instead
   *  of failing in a second. */
  it("turns off git's credential prompt", () => {
    expect(dotfilesScript("/home/sandbox/dotfiles", null)).toContain(
      "GIT_TERMINAL_PROMPT=0",
    );
  });

  /** A container is recreated whenever its environment signature changes, so
   *  this runs far more often than once. */
  it("is re-runnable: it clears the target before cloning", () => {
    const script = dotfilesScript("/home/sandbox/dotfiles", null);
    expect(script.indexOf("rm -rf")).toBeLessThan(script.indexOf("git clone"));
  });

  /** The URL is never interpolated into the script -- it arrives as an
   *  environment variable, so a repository name cannot become a command. */
  it("never puts the URL in the script", () => {
    expect(dotfilesScript("/home/sandbox/dotfiles", null)).toContain(
      '"$RC_DOTFILES_REPO"',
    );
  });

  it("prefers the user's own install command over anything conventional", () => {
    const script = dotfilesScript("/home/sandbox/dotfiles", "make install");
    expect(script).toContain("sh -c 'make install'");
    expect(script).not.toContain("install.sh");
  });

  /** Single quotes are the only quoting that is safe for arbitrary text, and
   *  an apostrophe in a command is the case that breaks a naive version. */
  it("quotes an install command containing a quote", () => {
    expect(shellQuote("echo 'hi'")).toBe(`'echo '\\''hi'\\'''`);
    const script = dotfilesScript("/home/sandbox/dotfiles", "echo 'hi'");
    expect(script).toContain(`sh -c 'echo '\\''hi'\\'''`);
  });

  /** if/elif rather than a shell function called as an `if` condition: `set -e`
   *  is suspended inside a condition, so an installer that FAILED would have
   *  been read as "no installer found" and fallen through to the linker as
   *  though nothing were wrong. */
  it("does not run the installer inside an if condition", () => {
    const script = dotfilesScript("/home/sandbox/dotfiles", null);
    expect(script).toContain('if [ -x "install.sh" ]; then ./install.sh');
    expect(script).toContain('elif [ -x "setup.sh" ]');
    expect(script).not.toContain("run_conventional");
  });

  it("falls back to linking top-level dotfiles, and leaves .git alone", () => {
    const script = dotfilesScript("/home/sandbox/dotfiles", null);
    expect(script).toContain("ln -sfn");
    expect(script).toContain(".git|.github) continue");
  });

  /** A real file already at that name is the user's. A symlink is one of ours
   *  from a previous run, and is replaced. */
  it("never overwrites a real file already in the home directory", () => {
    expect(dotfilesScript("/home/sandbox/dotfiles", null)).toContain(
      'if [ -e "$HOME/$f" ] && [ ! -L "$HOME/$f" ]; then continue; fi',
    );
  });
});

describe("applying them", () => {
  it("passes the URL through the environment, not through argv", async () => {
    await applyDotfiles(container, { repo: "https://x.test/d" }, 1000);

    const [, argv, options] = execCapture.mock.calls[0] as [
      unknown,
      string[],
      { env: Record<string, string> },
    ];
    expect(argv[0]).toBe("sh");
    expect(argv.join(" ")).not.toContain("https://x.test/d");
    expect(options.env.RC_DOTFILES_REPO).toBe("https://x.test/d");
  });

  it("reports a non-zero exit with the script's own output", async () => {
    execCapture.mockResolvedValue({
      stdout: "",
      stderr: "fatal: repository not found",
      exitCode: 128,
    });

    const result = await applyDotfiles(container, { repo: "https://x.test/d" }, 1000);

    expect(result.ok).toBe(false);
    expect(result.log).toContain("repository not found");
  });

  /** Settings outlive the rules that validated them, so a URL that is refused
   *  today may already be in the database from before it was. It has to fail
   *  as a message rather than as an unhandled throw inside a container start. */
  it("refuses a stored URL that would no longer be accepted", async () => {
    const result = await applyDotfiles(
      container,
      { repo: "ssh://git@github.com/you/d" },
      1000,
    );

    expect(result.ok).toBe(false);
    expect(result.log).toMatch(/authenticate as the server/);
    expect(execCapture).not.toHaveBeenCalled();
  });

  /** The exec keeps running inside the container -- there is no reaching in to
   *  stop it -- but the WAITING stops, which is what holds a project closed. */
  it("gives up rather than holding the start open", async () => {
    execCapture.mockReturnValue(new Promise(() => undefined));

    const result = await applyDotfiles(container, { repo: "https://x.test/d" }, 20);

    expect(result.ok).toBe(false);
    expect(result.log).toMatch(/gave up/);
  });
});
