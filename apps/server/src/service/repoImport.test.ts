import { beforeEach, describe, expect, it, vi } from "vitest";

const execCapture = vi.hoisted(() => vi.fn());
const ensureContainer = vi.hoisted(() => vi.fn(() => Promise.resolve({ id: "c" })));
const removeContainer = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const githubToken = vi.hoisted(() => vi.fn());
const assertCanCreateProject = vi.hoisted(() => vi.fn(() => Promise.resolve()));

const prisma = vi.hoisted(() => ({
  project: {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../containers/execCapture.js", () => ({ execCapture }));
vi.mock("../containers/containerManager.js", () => ({
  ensureContainer,
  removeContainer,
}));
vi.mock("../lib/prisma.js", () => ({ prisma }));
vi.mock("../service/githubService.js", () => ({ githubToken }));
vi.mock("./githubService.js", () => ({ githubToken }));
vi.mock("./userQuotaService.js", () => ({ assertCanCreateProject }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
}));

import { importRepository } from "./repoImportService.js";
import type { GithubRepo } from "./githubService.js";

const USER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const TOKEN = "gho_a-real-looking-token";

const REPO: GithubRepo = {
  id: 1,
  fullName: "octocat/hello",
  owner: "octocat",
  name: "hello",
  private: true,
  description: null,
  defaultBranch: "main",
  sizeKb: 500,
  language: "TypeScript",
  pushedAt: null,
};

/** The clone's argv and options, from the last exec. */
function lastExec() {
  const call = execCapture.mock.calls.at(-1);
  return {
    argv: (call?.[1] ?? []) as string[],
    options: (call?.[2] ?? {}) as { env?: Record<string, string> },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  githubToken.mockResolvedValue(TOKEN);
  execCapture.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  prisma.project.create.mockResolvedValue({
    id: PROJECT,
    name: "hello",
    template: "node-express",
    ownerId: USER,
  });
  prisma.project.update.mockResolvedValue({});
  prisma.project.delete.mockResolvedValue({});
});

describe("importRepository", () => {
  it("passes the token in the environment, never in the arguments", async () => {
    await importRepository(USER, { owner: "octocat", repo: "hello" }, REPO);

    const { argv, options } = lastExec();

    // Process arguments are readable by anything in the container through
    // /proc; an environment is not. And a token in the URL would be written
    // into .git/config as the remote.
    expect(options.env?.["RC_GIT_TOKEN"]).toBe(TOKEN);
    expect(argv.join(" ")).not.toContain(TOKEN);
  });

  it("builds the URL from the name rather than taking one", async () => {
    await importRepository(USER, { owner: "octocat", repo: "hello" }, REPO);

    // Never cloning a browser-supplied URL is what removes the `ext::`
    // transport question rather than answering it.
    expect(lastExec().argv).toContain("https://github.com/octocat/hello.git");
  });

  it("puts the URL after a `--`, so it cannot be read as an option", async () => {
    await importRepository(USER, { owner: "octocat", repo: "hello" }, REPO);

    const { argv } = lastExec();
    const separator = argv.indexOf("--");

    expect(separator).toBeGreaterThan(-1);
    expect(argv.slice(separator + 1)).toEqual([
      "https://github.com/octocat/hello.git",
      ".",
    ]);
  });

  it("does not fetch submodules", async () => {
    // They can point anywhere, including at a local path. Fetching them is a
    // decision, not a default.
    await importRepository(USER, { owner: "octocat", repo: "hello" }, REPO);
    expect(lastExec().argv).toContain("--no-recurse-submodules");
  });

  it("turns off git's terminal prompt, which would hang the exec", async () => {
    await importRepository(USER, { owner: "octocat", repo: "hello" }, REPO);
    expect(lastExec().options.env?.["GIT_TERMINAL_PROMPT"]).toBe("0");
  });

  it("clones a named branch when one is asked for", async () => {
    await importRepository(
      USER,
      { owner: "octocat", repo: "hello", ref: "release/2.0" },
      REPO,
    );

    const { argv } = lastExec();
    expect(argv[argv.indexOf("--branch") + 1]).toBe("release/2.0");
  });

  describe("what it refuses", () => {
    it("a repository that cannot fit, before downloading anything", async () => {
      // GitHub reports the size, so this is answerable up front — much better
      // than filling the disk and cleaning up after.
      await expect(
        importRepository(USER, { owner: "octocat", repo: "hello" }, {
          ...REPO,
          sizeKb: 5_000_000,
        }),
      ).rejects.toThrow(/does not fit/);

      expect(prisma.project.create).not.toHaveBeenCalled();
      expect(execCapture).not.toHaveBeenCalled();
    });

    it("a name that could be read as an option", async () => {
      await expect(
        importRepository(USER, { owner: "--upload-pack=evil", repo: "hello" }, REPO),
      ).rejects.toThrow(/not a valid GitHub name/);

      expect(execCapture).not.toHaveBeenCalled();
    });

    it("a name with a path separator in it", async () => {
      await expect(
        importRepository(USER, { owner: "a/../b", repo: "hello" }, REPO),
      ).rejects.toThrow(/not a valid GitHub name/);
    });

    it("a ref that could be read as an option", async () => {
      await expect(
        importRepository(USER, { owner: "octocat", repo: "hello", ref: "--exec=x" }, REPO),
      ).rejects.toThrow(/not valid/);
    });
  });

  describe("when the clone fails", () => {
    beforeEach(() => {
      execCapture.mockResolvedValue({
        stdout: "",
        stderr: "fatal: repository not found",
        exitCode: 1,
      });
    });

    it("leaves no project row behind", async () => {
      // A row pointing at a directory that was never populated is worse than
      // no row at all.
      await expect(
        importRepository(USER, { owner: "octocat", repo: "hello" }, REPO),
      ).rejects.toThrow(/repository not found/);

      expect(prisma.project.delete).toHaveBeenCalledWith({
        where: { id: PROJECT },
      });
    });

    it("removes the container it started", async () => {
      await importRepository(USER, { owner: "octocat", repo: "hello" }, REPO).catch(
        () => undefined,
      );

      expect(removeContainer).toHaveBeenCalledWith(PROJECT);
    });

    it("redacts the token out of whatever git said", async () => {
      execCapture.mockResolvedValue({
        stdout: "",
        stderr: `fatal: https://token:${TOKEN}@github.com/a/b.git not found`,
        exitCode: 1,
      });

      const error = await importRepository(
        USER,
        { owner: "octocat", repo: "hello" },
        REPO,
      ).catch((thrown: unknown) => thrown);

      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(TOKEN);
      expect(message).toContain("***");
    });
  });

  it("refuses before creating anything when the quota is spent", async () => {
    assertCanCreateProject.mockRejectedValue(new Error("Too many projects"));

    await expect(
      importRepository(USER, { owner: "octocat", repo: "hello" }, REPO),
    ).rejects.toThrow(/Too many projects/);

    expect(prisma.project.create).not.toHaveBeenCalled();
  });
});
