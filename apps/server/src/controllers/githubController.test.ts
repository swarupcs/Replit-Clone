import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  connectAuthorizeUrl: vi.fn((state: string) => `https://github.com/x?state=${state}`),
  connectGithub: vi.fn(),
  disconnectGithub: vi.fn(),
  githubConnection: vi.fn(),
  isGithubReposConfigured: vi.fn(() => true),
  listRepos: vi.fn(),
}));

vi.mock("../service/githubService.js", () => service);
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
}));

import {
  githubConnectCallback,
  githubConnectStart,
  githubConnectionStatus,
  githubDisconnect,
  githubReposController,
} from "./githubController.js";
import { apiApp, bearer, TEST_USER } from "../test/apiHarness.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { env } from "../config/env.js";
import { signAccessToken } from "../service/tokenService.js";

/** Auth off at the router, applied per route, because the callback is a
 *  browser redirect and deliberately carries no Authorization header. */
const app = apiApp(
  [
    {
      method: "get",
      path: "/github/status",
      handler: githubConnectionStatus,
      before: [requireAuth],
    },
    {
      method: "post",
      path: "/github/connect",
      handler: githubConnectStart,
      before: [requireAuth],
    },
    { method: "get", path: "/github/callback", handler: githubConnectCallback },
    {
      method: "delete",
      path: "/github/connection",
      handler: githubDisconnect,
      before: [requireAuth],
    },
    {
      method: "get",
      path: "/github/repos",
      handler: githubReposController,
      before: [requireAuth],
    },
  ],
  { auth: false },
);

const STATE_COOKIE = "gh_connect_state";
const ACTOR_COOKIE = "gh_connect_actor";

const CONNECTION = {
  login: "octocat",
  scopes: ["repo", "read:user"],
  connectedAt: new Date("2026-01-01"),
  canUseRepos: true,
};

function cookiesFrom(response: request.Response): Record<string, string> {
  const raw = response.headers["set-cookie"] as unknown as string[] | undefined;
  const found: Record<string, string> = {};

  for (const entry of raw ?? []) {
    const name = entry.slice(0, entry.indexOf("="));
    found[name] = decodeURIComponent(
      entry.slice(entry.indexOf("=") + 1, entry.indexOf(";")),
    );
  }

  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  service.isGithubReposConfigured.mockReturnValue(true);
  service.githubConnection.mockResolvedValue(null);
  service.connectGithub.mockResolvedValue(CONNECTION);
  service.disconnectGithub.mockResolvedValue(undefined);
  service.listRepos.mockResolvedValue({ repos: [], hasMore: false });
});

describe("GET /github/status", () => {
  it("separates 'the server offers this' from 'you have connected'", async () => {
    // The app needs both: one decides whether to show the button, the other
    // what the button says.
    const response = await request(app)
      .get("/github/status")
      .set("Authorization", bearer());

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ configured: true, connection: null });
  });

  it("does not even ask about a connection when unconfigured", async () => {
    service.isGithubReposConfigured.mockReturnValue(false);

    const response = await request(app)
      .get("/github/status")
      .set("Authorization", bearer());

    expect(response.body.data.configured).toBe(false);
    expect(service.githubConnection).not.toHaveBeenCalled();
  });
});

describe("POST /github/connect", () => {
  it("answers with a URL rather than redirecting", async () => {
    // Called by the app with its access token; a redirect would have to come
    // from a plain link, which cannot carry the header.
    const response = await request(app)
      .post("/github/connect")
      .set("Authorization", bearer());

    expect(response.status).toBe(200);
    expect(response.body.data.url).toMatch(/^https:\/\/github\.com\//);
  });

  it("sets a state cookie, and puts the same state in the URL", async () => {
    const response = await request(app)
      .post("/github/connect")
      .set("Authorization", bearer());

    const state = cookiesFrom(response)[STATE_COOKIE];

    expect(state).toBeTruthy();
    expect(response.body.data.url).toContain(`state=${state}`);
  });

  it("records who started it as a signed token, not a raw id", async () => {
    // This cookie decides whose account the returning authorisation attaches
    // to, so it has to be one this server issued.
    const response = await request(app)
      .post("/github/connect")
      .set("Authorization", bearer());

    const actor = cookiesFrom(response)[ACTOR_COOKIE];

    expect(actor).toBeTruthy();
    expect(actor).not.toBe(TEST_USER.sub);
    expect(actor?.split(".")).toHaveLength(3);
  });

  it("refuses when the server has no GitHub app configured", async () => {
    service.isGithubReposConfigured.mockReturnValue(false);

    const response = await request(app)
      .post("/github/connect")
      .set("Authorization", bearer());

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("GITHUB_NOT_CONFIGURED");
  });
});

describe("GET /github/callback", () => {
  const actor = () => signAccessToken({ sub: TEST_USER.sub, email: TEST_USER.email });

  it("stores the connection and sends the browser back to the app", async () => {
    const response = await request(app)
      .get("/github/callback?code=abc&state=s1")
      .set("Cookie", [`${STATE_COOKIE}=s1`, `${ACTOR_COOKIE}=${actor()}`]);

    expect(service.connectGithub).toHaveBeenCalledWith(TEST_USER.sub, "abc");
    expect(response.status).toBe(302);
    expect(response.headers["location"]).toBe(`${env.WEB_ORIGIN}/?github=connected`);
  });

  it("says so when GitHub granted less than was asked for", async () => {
    service.connectGithub.mockResolvedValue({ ...CONNECTION, canUseRepos: false });

    const response = await request(app)
      .get("/github/callback?code=abc&state=s1")
      .set("Cookie", [`${STATE_COOKIE}=s1`, `${ACTOR_COOKIE}=${actor()}`]);

    expect(response.headers["location"]).toBe(`${env.WEB_ORIGIN}/?github=limited`);
  });

  it("refuses a state that does not match the cookie", async () => {
    // A mismatch means this callback was not started by this browser, which is
    // exactly when attaching a token to an account would be wrong.
    const response = await request(app)
      .get("/github/callback?code=abc&state=forged")
      .set("Cookie", [`${STATE_COOKIE}=s1`, `${ACTOR_COOKIE}=${actor()}`]);

    expect(service.connectGithub).not.toHaveBeenCalled();
    expect(response.headers["location"]).toBe(`${env.WEB_ORIGIN}/?github=error`);
  });

  it("refuses when there is no state cookie at all", async () => {
    const response = await request(app)
      .get("/github/callback?code=abc&state=s1")
      .set("Cookie", [`${ACTOR_COOKIE}=${actor()}`]);

    expect(service.connectGithub).not.toHaveBeenCalled();
    expect(response.headers["location"]).toContain("github=error");
  });

  it("refuses an actor cookie this server did not sign", async () => {
    const response = await request(app)
      .get("/github/callback?code=abc&state=s1")
      .set("Cookie", [`${STATE_COOKIE}=s1`, `${ACTOR_COOKIE}=not.a.jwt`]);

    expect(service.connectGithub).not.toHaveBeenCalled();
    expect(response.headers["location"]).toContain("github=error");
  });

  it("clears both cookies whatever the outcome", async () => {
    // Good for exactly one attempt.
    const response = await request(app)
      .get("/github/callback?code=abc&state=mismatch")
      .set("Cookie", [`${STATE_COOKIE}=s1`, `${ACTOR_COOKIE}=${actor()}`]);

    const raw = (response.headers["set-cookie"] as unknown as string[]).join(";");
    expect(raw).toContain(`${STATE_COOKIE}=;`);
    expect(raw).toContain(`${ACTOR_COOKIE}=;`);
  });
});

describe("DELETE /github/connection", () => {
  it("disconnects the caller", async () => {
    const response = await request(app)
      .delete("/github/connection")
      .set("Authorization", bearer());

    expect(response.status).toBe(200);
    expect(service.disconnectGithub).toHaveBeenCalledWith(TEST_USER.sub);
  });

  it("needs a session", async () => {
    const response = await request(app).delete("/github/connection");
    expect(response.status).toBe(401);
  });
});


describe("GET /github/repos", () => {
  it("passes the query and page through", async () => {
    await request(app)
      .get("/github/repos?query=hello&page=3")
      .set("Authorization", bearer());

    expect(service.listRepos).toHaveBeenCalledWith(TEST_USER.sub, {
      query: "hello",
      page: 3,
    });
  });

  it("defaults to the first page, with no query", async () => {
    await request(app).get("/github/repos").set("Authorization", bearer());

    expect(service.listRepos).toHaveBeenCalledWith(TEST_USER.sub, { page: 1 });
  });

  it("caps the page, which is forwarded to GitHub", async () => {
    // Unbounded, it is a way to make this server issue arbitrarily many
    // requests on somebody's behalf.
    const response = await request(app)
      .get("/github/repos?page=100000")
      .set("Authorization", bearer());

    expect(response.status).toBe(400);
    expect(service.listRepos).not.toHaveBeenCalled();
  });

  it("needs a session", async () => {
    const response = await request(app).get("/github/repos");
    expect(response.status).toBe(401);
  });
});
