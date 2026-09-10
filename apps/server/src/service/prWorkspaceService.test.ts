import { beforeEach, describe, expect, it, vi } from "vitest";

/** The orchestration between the decision and the things that cost money.
 *
 *  Prisma and every container-touching call are mocked: this environment has no
 *  Docker daemon, so `importRepository` and `publish` cannot run. What is under
 *  test is which of them gets called, and when — which is the part that decides
 *  whether an unenrolled repository can spend this host's memory.
 */

const hoisted = vi.hoisted(() => ({
  prRepoFindUnique: vi.fn(),
  wsFindUnique: vi.fn(),
  wsFindFirst: vi.fn(),
  wsCreate: vi.fn(),
  wsUpdate: vi.fn(),
  wsDelete: vi.fn(),
  deliveryCreate: vi.fn(),
  importRepository: vi.fn(),
  publish: vi.fn(),
  trashProjectService: vi.fn(),
  githubApi: vi.fn(),
  githubToken: vi.fn(),
  getRepo: vi.fn(),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    pullRequestRepo: { findUnique: hoisted.prRepoFindUnique },
    pullRequestWorkspace: {
      findUnique: hoisted.wsFindUnique,
      findFirst: hoisted.wsFindFirst,
      create: hoisted.wsCreate,
      update: hoisted.wsUpdate,
      delete: hoisted.wsDelete,
    },
    webhookDelivery: { create: hoisted.deliveryCreate },
  },
}));

vi.mock("./repoImportService.js", () => ({ importRepository: hoisted.importRepository }));
vi.mock("./deployService.js", () => ({
  publish: hoisted.publish,
  siteUrl: (subdomain: string) => `https://${subdomain}.example.test`,
}));
vi.mock("./projectService.js", () => ({ trashProjectService: hoisted.trashProjectService }));
vi.mock("./githubService.js", () => ({
  githubApi: hoisted.githubApi,
  githubToken: hoisted.githubToken,
  getRepo: hoisted.getRepo,
}));

const { applyDecision, commentBody } = await import("./prWorkspaceService.js");

const SHA = "a".repeat(40);
const repo = { owner: "acme", repo: "widget" };
const pull = { number: 7, headRef: "feature", headSha: SHA, title: "Add a thing" };

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.prRepoFindUnique.mockResolvedValue({ userId: "user-1" });
  hoisted.wsFindUnique.mockResolvedValue(null);
  hoisted.wsFindFirst.mockResolvedValue(null);
  hoisted.githubToken.mockResolvedValue("gho_token");
  hoisted.getRepo.mockResolvedValue({ size: 100 });
  hoisted.importRepository.mockResolvedValue({ id: "project-1" });
  hoisted.publish.mockResolvedValue({ subdomain: "pr-7" });
  hoisted.githubApi.mockResolvedValue({ data: { id: 5150 }, headers: new Headers() });
  hoisted.wsCreate.mockResolvedValue({});
  hoisted.wsUpdate.mockResolvedValue({});
});

describe("a pull request on an enrolled repository", () => {
  it("imports the head ref and publishes it", async () => {
    const outcome = await applyDecision({ kind: "upsert", repo, pull });

    expect(outcome).toBe("created");
    expect(hoisted.importRepository).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ owner: "acme", repo: "widget", ref: "feature" }),
      expect.anything(),
    );
    expect(hoisted.publish).toHaveBeenCalledWith("project-1");
  });

  it("posts the link back as a comment", async () => {
    await applyDecision({ kind: "upsert", repo, pull });

    const [, path, init] = hoisted.githubApi.mock.calls[0] as [string, string, { body: { body: string } }];
    expect(path).toBe("/repos/acme/widget/issues/7/comments");
    expect(init.body.body).toContain("https://pr-7.example.test");
  });

  it("edits the existing comment on a later push rather than adding another", async () => {
    hoisted.wsFindUnique.mockResolvedValue({
      projectId: "project-1",
      headSha: "old",
      commentId: "5150",
    });

    const outcome = await applyDecision({ kind: "upsert", repo, pull });

    expect(outcome).toBe("refreshed");
    const [, path, init] = hoisted.githubApi.mock.calls[0] as [string, string, { method: string }];
    expect(path).toBe("/repos/acme/widget/issues/comments/5150");
    expect(init.method).toBe("PATCH");
  });

  it("does nothing when the head is already built", async () => {
    hoisted.wsFindUnique.mockResolvedValue({
      projectId: "project-1",
      headSha: SHA,
      commentId: null,
    });

    expect(await applyDecision({ kind: "upsert", repo, pull })).toBe("unchanged");
    expect(hoisted.publish).not.toHaveBeenCalled();
  });

  it("still delivers the workspace when the comment cannot be posted", async () => {
    // A read-only token should get the workspace without the comment, not
    // neither.
    hoisted.githubApi.mockRejectedValue(new Error("403"));

    expect(await applyDecision({ kind: "upsert", repo, pull })).toBe("created");
    expect(hoisted.publish).toHaveBeenCalled();
  });
});

describe("a pull request on a repository nobody enrolled", () => {
  it("starts nothing at all", async () => {
    // The security property of this row: an App installed on an organisation
    // delivers every repository's events, and an unenrolled one must not be
    // able to spend this host's memory.
    hoisted.prRepoFindUnique.mockResolvedValue(null);

    expect(await applyDecision({ kind: "upsert", repo, pull })).toBe("not-enrolled");
    expect(hoisted.importRepository).not.toHaveBeenCalled();
    expect(hoisted.publish).not.toHaveBeenCalled();
  });
});

describe("the key a repository is looked up by", () => {
  it("is case-insensitive, because GitHub sends whichever case it has", async () => {
    await applyDecision({
      kind: "upsert",
      repo: { owner: "ACME", repo: "Widget" },
      pull,
    });

    expect(hoisted.prRepoFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { owner_repo: { owner: "acme", repo: "widget" } } }),
    );
  });
});

describe("closing a pull request", () => {
  it("trashes the workspace, which is where the cost is", async () => {
    hoisted.wsFindUnique.mockResolvedValue({
      projectId: "project-1",
      project: { ownerId: "user-1" },
    });
    hoisted.wsDelete.mockResolvedValue({});

    const outcome = await applyDecision({ kind: "teardown", repo, number: 7, merged: true });

    expect(outcome).toBe("torn-down");
    expect(hoisted.trashProjectService).toHaveBeenCalledWith("project-1", "user-1");
    expect(hoisted.wsDelete).toHaveBeenCalled();
  });

  it("ignores a pull request that never had one", async () => {
    hoisted.wsFindUnique.mockResolvedValue(null);

    expect(await applyDecision({ kind: "teardown", repo, number: 99, merged: false })).toBe(
      "ignored",
    );
    expect(hoisted.trashProjectService).not.toHaveBeenCalled();
  });
});

describe("a push, which is §12.2's missing trigger", () => {
  it("refreshes the workspace of the pull request that branch belongs to", async () => {
    hoisted.wsFindFirst.mockResolvedValue({ number: 7 });
    hoisted.wsFindUnique.mockResolvedValue({
      projectId: "project-1",
      headSha: "old",
      commentId: null,
    });

    expect(
      await applyDecision({ kind: "rebuild", repo, branch: "feature", sha: SHA }),
    ).toBe("refreshed");
  });

  it("ignores a push to a branch with no pull request open", async () => {
    // GitHub sends `push` beside `pull_request` for the same commit, so this
    // is the common case rather than the odd one.
    hoisted.wsFindFirst.mockResolvedValue(null);

    expect(await applyDecision({ kind: "rebuild", repo, branch: "main", sha: SHA })).toBe(
      "ignored",
    );
    expect(hoisted.publish).not.toHaveBeenCalled();
  });
});

describe("the comment body", () => {
  it("carries the link and the commit it was built from", () => {
    const body = commentBody("https://pr-7.example.test", SHA);
    expect(body).toContain("https://pr-7.example.test");
    expect(body).toContain(SHA.slice(0, 7));
  });
});
