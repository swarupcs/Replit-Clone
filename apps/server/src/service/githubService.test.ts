import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  githubConnection: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
}));
vi.mock("../lib/prisma.js", () => ({ prisma }));

import {
  connectGithub,
  disconnectGithub,
  githubApi,
  githubConnection,
  githubToken,
  isGithubReposConfigured,
  listRepos,
  listPullRequests,
  createPullRequest,
  parseGithubRemote,
} from "./githubService.js";
import { env } from "../config/env.js";
import { seal } from "../lib/secretBox.js";

const USER = "11111111-1111-4111-8111-111111111111";
const TOKEN = "gho_a-real-looking-token";

/** A stored row, as Prisma would hand it back. */
function stored(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "c1",
    userId: USER,
    tokenCipher: seal(TOKEN),
    scopes: "repo,read:user",
    login: "octocat",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

/** Replaces global fetch for one test, returning the given responses in order. */
function respondWith(...responses: { status: number; body?: unknown }[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let at = 0;

  vi.stubGlobal(
    "fetch",
    (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const next = responses[Math.min(at, responses.length - 1)];
      at += 1;

      return Promise.resolve({
        ok: (next?.status ?? 200) < 400,
        status: next?.status ?? 200,
        json: () => Promise.resolve(next?.body),
        headers: new Headers(),
      } as unknown as Response);
    },
  );

  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  // Prisma's methods always return a promise; a mock that returns undefined is
  // an unfaithful stand-in, and the `.catch()` in the service would blow up on
  // it for a reason that has nothing to do with the behaviour under test.
  prisma.githubConnection.delete.mockResolvedValue({});
  prisma.githubConnection.deleteMany.mockResolvedValue({ count: 1 });
  env.GITHUB_CLIENT_ID = "client-id";
  env.GITHUB_CLIENT_SECRET = "client-secret";
});

describe("isGithubReposConfigured", () => {
  it("needs an OAuth app and somewhere to keep the answer", () => {
    expect(isGithubReposConfigured()).toBe(true);

    delete env.GITHUB_CLIENT_ID;
    expect(isGithubReposConfigured()).toBe(false);
  });

  it("is false without an encryption key, even with an OAuth app", () => {
    // Storing the token in plaintext would be the alternative, and it is not
    // one — so the feature reports itself off instead.
    const key = env.SECRET_ENCRYPTION_KEY;
    delete env.SECRET_ENCRYPTION_KEY;

    expect(isGithubReposConfigured()).toBe(false);

    env.SECRET_ENCRYPTION_KEY = key;
  });
});

describe("connectGithub", () => {
  it("stores the token encrypted, never in the clear", async () => {
    respondWith(
      { status: 200, body: { access_token: TOKEN, scope: "repo,read:user" } },
      { status: 200, body: { login: "octocat", id: 1 } },
    );
    prisma.githubConnection.upsert.mockImplementation(
      ({ create }: { create: Record<string, string> }) =>
        Promise.resolve(stored(create)),
    );

    await connectGithub(USER, "the-code");

    const written = prisma.githubConnection.upsert.mock.calls[0]?.[0] as {
      create: { tokenCipher: string };
      update: { tokenCipher: string };
    };

    // The whole security property of the row.
    expect(written.create.tokenCipher).not.toContain(TOKEN);
    expect(written.update.tokenCipher).not.toContain(TOKEN);
  });

  it("records what GitHub granted, not what was asked for", async () => {
    // An organisation can withhold `repo`. The app has to be able to say which
    // operation is unavailable and why, rather than failing at the API call.
    respondWith(
      { status: 200, body: { access_token: TOKEN, scope: "read:user" } },
      { status: 200, body: { login: "octocat", id: 1 } },
    );
    prisma.githubConnection.upsert.mockResolvedValue(
      stored({ scopes: "read:user" }),
    );

    const info = await connectGithub(USER, "the-code");

    expect(info.scopes).toEqual(["read:user"]);
    expect(info.canUseRepos).toBe(false);
  });

  it("refuses when GitHub hands back no token", async () => {
    respondWith({ status: 200, body: { error: "bad_verification_code" } });

    await expect(connectGithub(USER, "stale")).rejects.toThrow(/rejected/);
    expect(prisma.githubConnection.upsert).not.toHaveBeenCalled();
  });
});

describe("githubConnection", () => {
  it("describes the connection without the token", async () => {
    prisma.githubConnection.findUnique.mockResolvedValue(stored());

    const info = await githubConnection(USER);

    expect(info).toEqual({
      login: "octocat",
      scopes: ["repo", "read:user"],
      connectedAt: new Date("2026-01-01"),
      canUseRepos: true,
    });
    // Nothing resembling a credential reaches the caller.
    expect(JSON.stringify(info)).not.toContain(TOKEN);
  });

  it("is null when there is none", async () => {
    prisma.githubConnection.findUnique.mockResolvedValue(null);
    expect(await githubConnection(USER)).toBeNull();
  });
});

describe("githubToken", () => {
  it("hands back the decrypted token", async () => {
    prisma.githubConnection.findUnique.mockResolvedValue(stored());
    expect(await githubToken(USER)).toBe(TOKEN);
  });

  it("asks the user to connect when there is nothing stored", async () => {
    prisma.githubConnection.findUnique.mockResolvedValue(null);
    await expect(githubToken(USER)).rejects.toThrow(/Connect your GitHub/);
  });

  it("drops a row it can no longer read, rather than failing forever", async () => {
    // The key rotated, or the row was written under a different one. Left in
    // place it fails on every future call with nothing the user can do.
    prisma.githubConnection.findUnique.mockResolvedValue(
      stored({ tokenCipher: "v1.not.a.value" }),
    );

    await expect(githubToken(USER)).rejects.toThrow(/Connect again/);
    expect(prisma.githubConnection.delete).toHaveBeenCalledWith({
      where: { userId: USER },
    });
  });
});

describe("githubApi", () => {
  it("names re-authentication as the remedy for a 401", async () => {
    respondWith({ status: 401, body: { message: "Bad credentials" } });

    await expect(githubApi(TOKEN, "/user")).rejects.toMatchObject({
      code: "GITHUB_REAUTH_REQUIRED",
    });
  });

  it("passes GitHub's own message through for other failures", async () => {
    // "Validation Failed" with a reason is the useful part; replacing it with
    // something vaguer helps nobody.
    respondWith({ status: 422, body: { message: "A pull request already exists" } });

    await expect(githubApi(TOKEN, "/repos/a/b/pulls")).rejects.toThrow(
      /already exists/,
    );
  });

  it("sends the token as a bearer, and pins the API version", async () => {
    const calls = respondWith({ status: 200, body: {} });

    await githubApi(TOKEN, "/user");

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("survives a 204, which has no body to parse", async () => {
    respondWith({ status: 204 });
    await expect(githubApi(TOKEN, "/user/starred/a/b")).resolves.toBeDefined();
  });
});

describe("disconnectGithub", () => {
  it("deletes the row rather than flagging it", async () => {
    // Disconnecting should mean the credential is gone from this server.
    await disconnectGithub(USER);
    expect(prisma.githubConnection.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER },
    });
  });
});


describe("listRepos", () => {
  /** GitHub's shape, of which the service keeps a fraction. */
  function raw(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 1,
      full_name: "octocat/hello",
      name: "hello",
      owner: { login: "octocat" },
      private: false,
      description: "greeting",
      default_branch: "main",
      size: 120,
      language: "TypeScript",
      pushed_at: "2026-01-02T00:00:00Z",
      ...overrides,
    };
  }

  beforeEach(() => {
    prisma.githubConnection.findUnique.mockResolvedValue(stored());
  });

  it("keeps only what a picker needs", async () => {
    // GitHub's own object is about a hundred fields; passing it through would
    // put a great deal of somebody's account into a response for no reason.
    respondWith({ status: 200, body: [raw()] });

    const { repos } = await listRepos(USER);

    expect(repos[0]).toEqual({
      id: 1,
      fullName: "octocat/hello",
      owner: "octocat",
      name: "hello",
      private: false,
      description: "greeting",
      defaultBranch: "main",
      sizeKb: 120,
      language: "TypeScript",
      pushedAt: "2026-01-02T00:00:00Z",
    });
  });

  it("asks only for repositories the user can push to", async () => {
    // The default affiliation includes read-only repositories, which cannot be
    // pushed to and would be a frustrating thing to import.
    const calls = respondWith({ status: 200, body: [] });

    await listRepos(USER);

    expect(calls[0]?.url).toContain("affiliation=owner%2Ccollaborator%2Corganization_member");
    expect(calls[0]?.url).toContain("sort=pushed");
  });

  it("searches server-side rather than filtering a page", async () => {
    // Filtering the thirty repositories that happened to load looks like search
    // and is not.
    const calls = respondWith({
      status: 200,
      body: { items: [raw()], total_count: 1 },
    });

    await listRepos(USER, { query: "hello" });

    expect(calls[0]?.url).toContain("/search/repositories");
    expect(decodeURIComponent(calls[0]?.url ?? "")).toContain("user:@me");
  });

  it("reports more pages from the total when searching", async () => {
    respondWith({ status: 200, body: { items: [raw()], total_count: 90 } });

    expect((await listRepos(USER, { query: "a" })).hasMore).toBe(true);
  });

  it("treats a full page as possibly-not-the-last when listing", async () => {
    // /user/repos gives no count, so a full page means "ask again"; the next
    // request answering empty is cheaper than a count GitHub does not provide.
    respondWith({ status: 200, body: Array.from({ length: 30 }, () => raw()) });
    expect((await listRepos(USER)).hasMore).toBe(true);

    respondWith({ status: 200, body: [raw()] });
    expect((await listRepos(USER)).hasMore).toBe(false);
  });

  it("refuses when nothing is connected", async () => {
    prisma.githubConnection.findUnique.mockResolvedValue(null);
    await expect(listRepos(USER)).rejects.toThrow(/Connect your GitHub/);
  });
});


describe("parseGithubRemote", () => {
  it("reads the three shapes a remote is actually written in", () => {
    const expected = { owner: "octocat", repo: "hello" };

    for (const url of [
      "https://github.com/octocat/hello.git",
      "https://github.com/octocat/hello",
      "https://token@github.com/octocat/hello.git",
      "ssh://git@github.com/octocat/hello.git",
      "git@github.com:octocat/hello.git",
      "git@github.com:octocat/hello",
    ]) {
      expect(parseGithubRemote(url)).toEqual(expected);
    }
  });

  it("tolerates a trailing slash and surrounding space", () => {
    expect(parseGithubRemote("  https://github.com/octocat/hello/  ")).toEqual({
      owner: "octocat",
      repo: "hello",
    });
  });

  it("is null for anything that is not GitHub", () => {
    // Which is how the panel knows not to offer a pull request at all.
    expect(parseGithubRemote("https://gitlab.com/octocat/hello.git")).toBeNull();
    expect(parseGithubRemote("git@bitbucket.org:octocat/hello.git")).toBeNull();
    expect(parseGithubRemote("/srv/repos/hello.git")).toBeNull();
    expect(parseGithubRemote("")).toBeNull();
  });

  it("is null for a GitHub URL that names no repository", () => {
    expect(parseGithubRemote("https://github.com/octocat")).toBeNull();
    expect(parseGithubRemote("https://github.com/")).toBeNull();
  });

  it("does not match a host that merely ends in github.com", () => {
    // `notgithub.com` and `github.com.evil.test` are different hosts.
    expect(parseGithubRemote("https://github.com.evil.test/a/b.git")).toBeNull();
    expect(parseGithubRemote("git@evilgithub.com:a/b.git")).toBeNull();
  });
});

describe("pull requests", () => {
  const RAW = {
    number: 7,
    title: "Add a thing",
    html_url: "https://github.com/octocat/hello/pull/7",
    state: "open",
    draft: false,
    head: { ref: "feature" },
    base: { ref: "main" },
  };

  beforeEach(() => {
    prisma.githubConnection.findUnique.mockResolvedValue(stored());
  });

  it("qualifies the head branch with the owner", async () => {
    // Unqualified, GitHub silently matches nothing — which would look like
    // "no pull request exists" for a branch that has one.
    const calls = respondWith({ status: 200, body: [RAW] });

    await listPullRequests(USER, "octocat", "hello", "feature");

    expect(decodeURIComponent(calls[0]?.url ?? "")).toContain("head=octocat:feature");
  });

  it("reduces a pull request to what the panel shows", async () => {
    respondWith({ status: 200, body: [RAW] });

    expect((await listPullRequests(USER, "octocat", "hello"))[0]).toEqual({
      number: 7,
      title: "Add a thing",
      url: "https://github.com/octocat/hello/pull/7",
      state: "open",
      draft: false,
      head: "feature",
      base: "main",
    });
  });

  it("opens one with the branches it was given", async () => {
    const calls = respondWith({ status: 200, body: RAW });

    await createPullRequest(USER, {
      owner: "octocat",
      repo: "hello",
      title: "Add a thing",
      head: "feature",
      base: "main",
    });

    const body = JSON.parse((calls[0]?.init?.body ?? "{}") as string) as Record<string, unknown>;
    expect(calls[0]?.init?.method).toBe("POST");
    expect(body).toEqual({ title: "Add a thing", head: "feature", base: "main" });
  });

  it("omits an empty body and draft rather than sending nulls", async () => {
    const calls = respondWith({ status: 200, body: RAW });

    await createPullRequest(USER, {
      owner: "octocat",
      repo: "hello",
      title: "t",
      head: "f",
      base: "m",
      body: "",
      draft: false,
    });

    const body = JSON.parse((calls[0]?.init?.body ?? "{}") as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("body");
    expect(body).not.toHaveProperty("draft");
  });

  it("passes GitHub's refusal through, since it is the useful part", async () => {
    respondWith({
      status: 422,
      body: { message: "A pull request already exists for octocat:feature." },
    });

    await expect(
      createPullRequest(USER, {
        owner: "octocat",
        repo: "hello",
        title: "t",
        head: "feature",
        base: "main",
      }),
    ).rejects.toThrow(/already exists/);
  });
});
