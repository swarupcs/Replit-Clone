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
