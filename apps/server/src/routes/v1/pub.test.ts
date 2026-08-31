import request from "supertest";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const keys = vi.hoisted(() => ({ verifyApiKey: vi.fn() }));
const access = vi.hoisted(() => ({
  listAccessibleProjects: vi.fn(),
  assertProjectAccess: vi.fn(),
}));
const projects = vi.hoisted(() => ({ createProjectService: vi.fn() }));
const deploys = vi.hoisted(() => ({ publish: vi.fn() }));
const account = vi.hoisted(() => ({ getAccountSummary: vi.fn() }));

vi.mock("../../service/apiKeyService.js", () => keys);
vi.mock("../../service/projectAccessService.js", () => access);
vi.mock("../../service/projectService.js", () => projects);
vi.mock("../../service/deployService.js", () => deploys);
vi.mock("../../service/accountService.js", () => account);
vi.mock("../../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
}));

import pubRouter from "./pub.js";
import { requireAuth } from "../../middlewares/requireAuth.js";
import { errorHandler } from "../../middlewares/errorHandler.js";
import { UnauthorizedError } from "../../utils/errors.js";

const USER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SECRET = "rc_abcdef012345_0123456789abcdef";

function app() {
  const server = express();
  server.use(express.json());
  server.use("/pub", pubRouter);
  server.use(errorHandler);
  return server;
}

/** A session route, built the way the real ones are, to check the other half
 *  of the containment claim: that a key cannot authenticate against one. */
function sessionApp() {
  const server = express();
  server.use(express.json());
  server.get("/projects", requireAuth, (_req, res) => {
    res.json({ success: true });
  });
  server.use(errorHandler);
  return server;
}

function granted(scopes: string[]) {
  keys.verifyApiKey.mockResolvedValue({
    userId: USER,
    email: "someone@example.com",
    keyId: "key-1",
    scopes,
  });
}

beforeEach(() => {
  keys.verifyApiKey
    .mockReset()
    .mockRejectedValue(new UnauthorizedError("no", "BAD_API_KEY"));
  access.listAccessibleProjects.mockReset().mockResolvedValue([]);
  access.assertProjectAccess.mockReset().mockResolvedValue(undefined);
  projects.createProjectService.mockReset().mockResolvedValue({ id: PROJECT });
  deploys.publish.mockReset().mockResolvedValue({ status: "BUILDING" });
  account.getAccountSummary.mockReset().mockResolvedValue({ projects: 0 });
});

describe("a key with the right scope", () => {
  it("can list the projects it can reach", async () => {
    granted(["projects:read"]);

    const response = await request(app())
      .get("/pub/projects")
      .set("Authorization", `Bearer ${SECRET}`);

    expect(response.status).toBe(200);
    expect(access.listAccessibleProjects).toHaveBeenCalledWith(USER);
  });

  it("can create a project", async () => {
    granted(["projects:write"]);

    const response = await request(app())
      .post("/pub/projects")
      .set("Authorization", `Bearer ${SECRET}`)
      .send({ name: "From CI", template: "node-express" });

    expect(response.status).toBe(201);
    expect(projects.createProjectService).toHaveBeenCalledWith(
      USER,
      "From CI",
      "node-express",
    );
  });

  /** Publishing decides what strangers are served, so the level is named here
   *  rather than defaulted — the thing §3.1 records one endpoint as failing to
   *  do. */
  it("can publish, as the owner and not merely an editor", async () => {
    granted(["deploy"]);

    const response = await request(app())
      .post(`/pub/projects/${PROJECT}/deployment`)
      .set("Authorization", `Bearer ${SECRET}`);

    expect(response.status).toBe(200);
    expect(access.assertProjectAccess).toHaveBeenCalledWith(
      PROJECT,
      USER,
      "owner",
    );
    expect(deploys.publish).toHaveBeenCalledWith(PROJECT);
  });
});

describe("a key without the scope", () => {
  it("is refused, and told which scope it lacks", async () => {
    granted(["projects:read"]);

    const response = await request(app())
      .post(`/pub/projects/${PROJECT}/deployment`)
      .set("Authorization", `Bearer ${SECRET}`);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("MISSING_SCOPE");
    expect(deploys.publish).not.toHaveBeenCalled();
  });

  /** Read is not write. A key handed the narrowest scope is the common case,
   *  and it must not turn out to include creation. */
  it("cannot create a project with a read scope", async () => {
    granted(["projects:read"]);

    const response = await request(app())
      .post("/pub/projects")
      .set("Authorization", `Bearer ${SECRET}`)
      .send({});

    expect(response.status).toBe(403);
    expect(projects.createProjectService).not.toHaveBeenCalled();
  });
});

describe("what a key cannot reach at all", () => {
  /** The containment claim, and the reason keys have a router of their own: a
   *  key that authenticated everywhere would inherit the whole signed-in
   *  surface, and the only thing between a leaked CI secret and every project
   *  deleted would be a list of exceptions somebody kept complete by hand. */
  it("is a session route, even with a valid key", async () => {
    granted(["projects:read", "projects:write", "deploy"]);

    const response = await request(sessionApp())
      .get("/projects")
      .set("Authorization", `Bearer ${SECRET}`);

    expect(response.status).toBe(401);
  });

  /** ...and there is no route here that deletes anything, mints a key, or
   *  touches the plan. Asserted as 404s, because the guarantee is that they
   *  were never written rather than that they are guarded. */
  it("is anything destructive, or anything about the account itself", async () => {
    granted(["projects:read", "projects:write", "deploy"]);

    const server = app();
    const paths: [string, string][] = [
      ["delete", `/pub/projects/${PROJECT}`],
      ["get", "/pub/account/keys"],
      ["post", "/pub/account/keys"],
    ];

    for (const [method, path] of paths) {
      const agent = request(server);
      const response = await agent[method as "get"](path).set(
        "Authorization",
        `Bearer ${SECRET}`,
      );

      expect(response.status).toBe(404);
    }
  });
});

describe("a request with no key, or a bad one", () => {
  it("is refused before anything is done", async () => {
    const missing = await request(app()).get("/pub/projects");
    expect(missing.status).toBe(401);

    const bad = await request(app())
      .get("/pub/projects")
      .set("Authorization", "Bearer nonsense");
    expect(bad.status).toBe(401);

    expect(access.listAccessibleProjects).not.toHaveBeenCalled();
  });
});
