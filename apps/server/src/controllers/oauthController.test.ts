import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const oauthService = vi.hoisted(() => ({
  githubAuthorizeUrl: vi.fn((state: string) => `https://github.com/login?state=${state}`),
  isGithubConfigured: vi.fn(() => true),
  signInWithGithub: vi.fn(),
}));
const issueRefreshToken = vi.hoisted(() => vi.fn());

vi.mock("../service/oauthService.js", () => oauthService);
vi.mock("../service/refreshTokenService.js", () => ({ issueRefreshToken }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
}));

import { authProviders, githubCallback, githubStart } from "./oauthController.js";
import { apiApp, TEST_USER } from "../test/apiHarness.js";
import { env } from "../config/env.js";
import { PREVIEW_COOKIE_NAME, REFRESH_COOKIE_NAME } from "../service/tokenService.js";

const app = apiApp(
  [
    { method: "get", path: "/auth/providers", handler: authProviders },
    { method: "get", path: "/auth/github", handler: githubStart },
    { method: "get", path: "/auth/github/callback", handler: githubCallback },
  ],
  { auth: false },
);

const STATE_COOKIE = "oauth_state";
const USER = { id: TEST_USER.sub, email: TEST_USER.email };

function setCookies(response: request.Response): Record<string, string> {
  const raw = response.headers["set-cookie"] as unknown as string[] | undefined;
  const found: Record<string, string> = {};
  for (const entry of raw ?? []) found[entry.slice(0, entry.indexOf("="))] = entry;
  return found;
}

function cookieValue(entry: string): string {
  return decodeURIComponent(entry.slice(entry.indexOf("=") + 1, entry.indexOf(";")));
}

/** Pulls the state the controller minted out of its own Set-Cookie header. */
async function startAndCaptureState(): Promise<string> {
  const response = await request(app).get("/auth/github");
  return cookieValue(setCookies(response)[STATE_COOKIE]!);
}

beforeEach(() => {
  vi.clearAllMocks();
  oauthService.isGithubConfigured.mockReturnValue(true);
  oauthService.githubAuthorizeUrl.mockImplementation(
    (state: string) => `https://github.com/login?state=${state}`,
  );
  issueRefreshToken.mockResolvedValue({ token: "refresh-token" });
});

describe("authProviders", () => {
  it.each([[true], [false]])("reports github configured = %s", async (configured) => {
    oauthService.isGithubConfigured.mockReturnValue(configured);

    const response = await request(app).get("/auth/providers");

    expect(response.status).toBe(200);
    // `singleUser` joined this payload when the endpoint stopped being only
    // about GitHub: three links on the sign-in form lead to routes that mode
    // does not mount, and the app needs to be told which.
    expect(response.body.data).toEqual({
      github: configured,
      singleUser: false,
    });
  });
});

describe("githubStart", () => {
  it("redirects to GitHub", async () => {
    const response = await request(app).get("/auth/github");

    expect(response.status).toBe(302);
    expect(response.headers["location"]).toMatch(/^https:\/\/github\.com\/login/);
  });

  /** The state parameter is what makes the callback verifiable: without it
   *  anyone could send a victim to our callback with a code of their own. */
  it("mints an unguessable state and keeps a copy in an httpOnly cookie", async () => {
    const response = await request(app).get("/auth/github");
    const cookie = setCookies(response)[STATE_COOKIE];

    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/i);

    const state = cookieValue(cookie!);
    expect(state.length).toBeGreaterThanOrEqual(32);
    // The same value is what GitHub is asked to echo back.
    expect(response.headers["location"]).toContain(state);
  });

  it("mints a different state every time", async () => {
    const first = await startAndCaptureState();
    const second = await startAndCaptureState();

    expect(first).not.toBe(second);
  });
});

describe("githubCallback", () => {
  it("signs the user in and redirects to the web app", async () => {
    const state = await startAndCaptureState();
    oauthService.signInWithGithub.mockResolvedValue(USER);

    const response = await request(app)
      .get("/auth/github/callback")
      .query({ code: "gh-code", state })
      .set("Cookie", `${STATE_COOKIE}=${state}`);

    expect(response.status).toBe(302);
    expect(response.headers["location"]).toBe(env.WEB_ORIGIN);
    expect(oauthService.signInWithGithub).toHaveBeenCalledWith("gh-code");
  });

  it("sets the same session cookies an ordinary sign-in would", async () => {
    const state = await startAndCaptureState();
    oauthService.signInWithGithub.mockResolvedValue(USER);

    const response = await request(app)
      .get("/auth/github/callback")
      .query({ code: "gh-code", state })
      .set("Cookie", `${STATE_COOKIE}=${state}`);

    const cookies = setCookies(response);
    expect(cookieValue(cookies[REFRESH_COOKIE_NAME]!)).toBe("refresh-token");
    expect(cookies[REFRESH_COOKIE_NAME]).toMatch(/HttpOnly/i);
    expect(cookies[PREVIEW_COOKIE_NAME]).toMatch(/Path=\/preview/i);
    expect(issueRefreshToken).toHaveBeenCalledWith(USER.id);
  });

  /** Good for exactly one attempt, whatever the outcome. */
  it.each([
    ["success", { code: "gh-code" }, true],
    ["a missing code", {}, false],
    ["a bad state", { code: "gh-code", state: "wrong" }, false],
  ])("clears the state cookie on %s", async (_label, query, useRealState) => {
    const state = await startAndCaptureState();
    oauthService.signInWithGithub.mockResolvedValue(USER);

    const response = await request(app)
      .get("/auth/github/callback")
      .query(useRealState ? { ...query, state } : query)
      .set("Cookie", `${STATE_COOKIE}=${state}`);

    expect(cookieValue(setCookies(response)[STATE_COOKIE]!)).toBe("");
  });

  it.each([
    ["no code at all", (state: string) => ({ state })],
    ["an empty code", (state: string) => ({ code: "", state })],
  ])("sends the browser back to login when there is %s", async (_label, query) => {
    const state = await startAndCaptureState();

    const response = await request(app)
      .get("/auth/github/callback")
      .query(query(state))
      .set("Cookie", `${STATE_COOKIE}=${state}`);

    expect(response.headers["location"]).toBe(`${env.WEB_ORIGIN}/login?error=github`);
    expect(oauthService.signInWithGithub).not.toHaveBeenCalled();
  });

  /** A mismatch means this callback was not started by this browser — the whole
   *  point of carrying the state through. */
  it.each([
    ["the state does not match the cookie", "attacker-state", "victim-state"],
    ["there is no state in the query", undefined, "victim-state"],
    ["there is no state cookie", "some-state", undefined],
  ])("refuses when %s", async (_label, queryState, cookieState) => {
    const response = await request(app)
      .get("/auth/github/callback")
      .query({ code: "gh-code", ...(queryState ? { state: queryState } : {}) })
      .set("Cookie", cookieState ? `${STATE_COOKIE}=${cookieState}` : "");

    expect(response.headers["location"]).toBe(`${env.WEB_ORIGIN}/login?error=github`);
    expect(oauthService.signInWithGithub).not.toHaveBeenCalled();
    expect(issueRefreshToken).not.toHaveBeenCalled();
  });

  it("redirects to login rather than 500ing when GitHub rejects the code", async () => {
    const { UnauthorizedError } = await import("../utils/errors.js");
    const state = await startAndCaptureState();
    oauthService.signInWithGithub.mockRejectedValue(
      new UnauthorizedError("GitHub would not accept that code"),
    );

    const response = await request(app)
      .get("/auth/github/callback")
      .query({ code: "gh-code", state })
      .set("Cookie", `${STATE_COOKIE}=${state}`);

    expect(response.status).toBe(302);
    expect(response.headers["location"]).toBe(`${env.WEB_ORIGIN}/login?error=github`);
    expect(setCookies(response)[REFRESH_COOKIE_NAME]).toBeUndefined();
  });

  /** An unexpected failure is not a failed sign-in, and pretending otherwise
   *  would hide a broken deployment behind a login page. */
  it("lets an unexpected failure reach the error handler", async () => {
    const state = await startAndCaptureState();
    oauthService.signInWithGithub.mockRejectedValue(new Error("database is down"));

    const response = await request(app)
      .get("/auth/github/callback")
      .query({ code: "gh-code", state })
      .set("Cookie", `${STATE_COOKIE}=${state}`);

    expect(response.status).toBe(500);
    expect(response.body.message).toBe("Something went wrong");
  });
});
