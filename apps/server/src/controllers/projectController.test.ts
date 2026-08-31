import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const projectService = vi.hoisted(() => ({
  createProjectService: vi.fn(),
  deleteProjectService: vi.fn(),
  duplicateProjectService: vi.fn(),
  renameProjectService: vi.fn(),
  assertProjectAccess: vi.fn(),
  projectDir: vi.fn(() => "/tmp/project"),
  EXCLUDED_GLOBS: ["node_modules/**"],
}));

const projectEnvService = vi.hoisted(() => ({
  getEnvVars: vi.fn(),
  setEnvVars: vi.fn(),
}));

const projectAccessService = vi.hoisted(() => ({
  listAccessibleProjects: vi.fn(),
}));

const fileTreeService = vi.hoisted(() => ({ buildFileTree: vi.fn() }));

vi.mock("../service/projectService.js", () => projectService);
vi.mock("../service/projectEnvService.js", () => projectEnvService);
vi.mock("../service/projectAccessService.js", () => projectAccessService);
vi.mock("../service/fileTreeService.js", () => fileTreeService);
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
}));

import {
  createProjectController,
  deleteProjectController,
  duplicateProjectController,
  getProjectEnvController,
  getProjectPorts,
  getProjectTree,
  listProjectsController,
  listTemplatesController,
  renameProjectController,
  setProjectEnvController,
} from "./projectController.js";
import { apiApp, bearer, TEST_PROJECT, TEST_USER } from "../test/apiHarness.js";
import { DEFAULT_TEMPLATE_ID } from "../templates/registry.js";
import { ForbiddenError, NotFoundError } from "../utils/errors.js";

const app = apiApp([
  { method: "post", path: "/projects", handler: createProjectController },
  { method: "get", path: "/projects", handler: listProjectsController },
  { method: "get", path: "/projects/templates", handler: listTemplatesController },
  { method: "get", path: "/projects/:projectId/tree", handler: getProjectTree },
  { method: "get", path: "/projects/:projectId/ports", handler: getProjectPorts },
  { method: "get", path: "/projects/:projectId/env", handler: getProjectEnvController },
  { method: "put", path: "/projects/:projectId/env", handler: setProjectEnvController },
  { method: "patch", path: "/projects/:projectId", handler: renameProjectController },
  { method: "delete", path: "/projects/:projectId", handler: deleteProjectController },
  {
    method: "post",
    path: "/projects/:projectId/duplicate",
    handler: duplicateProjectController,
  },
]);

const PROJECT = { id: TEST_PROJECT, name: "demo", template: "react-vite" };

beforeEach(() => {
  vi.clearAllMocks();
  projectService.assertProjectAccess.mockResolvedValue(PROJECT);
});

describe("createProjectController", () => {
  it("creates a project and answers 201", async () => {
    projectService.createProjectService.mockResolvedValue(PROJECT);

    const response = await request(app)
      .post("/projects")
      .set("Authorization", bearer())
      .send({ name: "demo", template: "python-flask" });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ success: true, data: PROJECT });
    expect(projectService.createProjectService).toHaveBeenCalledWith(
      TEST_USER.sub,
      "demo",
      "python-flask",
    );
  });

  it("falls back to the default template when none is named", async () => {
    projectService.createProjectService.mockResolvedValue(PROJECT);

    await request(app).post("/projects").set("Authorization", bearer()).send({});

    expect(projectService.createProjectService).toHaveBeenCalledWith(
      TEST_USER.sub,
      undefined,
      DEFAULT_TEMPLATE_ID,
    );
  });

  it("creates the project for the caller, never for an id in the body", async () => {
    projectService.createProjectService.mockResolvedValue(PROJECT);

    await request(app)
      .post("/projects")
      .set("Authorization", bearer())
      .send({ name: "demo", ownerId: "99999999-9999-4999-8999-999999999999" });

    expect(projectService.createProjectService).toHaveBeenCalledWith(
      TEST_USER.sub,
      "demo",
      DEFAULT_TEMPLATE_ID,
    );
  });

  it.each([
    ["an empty name", { name: "" }],
    ["a whitespace-only name", { name: "   " }],
    ["an over-long name", { name: "x".repeat(101) }],
    ["a non-string name", { name: 42 }],
    ["an over-long template id", { template: "y".repeat(51) }],
  ])("rejects %s with a 400", async (_label, body) => {
    const response = await request(app)
      .post("/projects")
      .set("Authorization", bearer())
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
    expect(projectService.createProjectService).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    const response = await request(app).post("/projects").send({ name: "demo" });

    expect(response.status).toBe(401);
    expect(projectService.createProjectService).not.toHaveBeenCalled();
  });
});

describe("listProjectsController", () => {
  /** Regression guard: listing only OWNED projects makes a project someone
   *  shared with you impossible to reach, since the dashboard is how you open
   *  one. */
  it("lists everything the user can reach, not only what they own", async () => {
    projectAccessService.listAccessibleProjects.mockResolvedValue({
      items: [PROJECT],
      nextCursor: null,
    });

    const response = await request(app).get("/projects").set("Authorization", bearer());

    expect(response.status).toBe(200);
    // A page, not an array: an array is the one shape that cannot say there
    // is more, which is what this list used to do with no cap at all.
    expect(response.body.data).toEqual({ items: [PROJECT], nextCursor: null });
    // The query object reaches the service, so `?cursor=` is not silently
    // dropped on the one list a script is most likely to page through.
    expect(projectAccessService.listAccessibleProjects).toHaveBeenCalledWith(
      TEST_USER.sub,
      {},
    );
  });
});

describe("listTemplatesController", () => {
  it("returns the picker's fields and nothing about the server's images", async () => {
    const response = await request(app)
      .get("/projects/templates")
      .set("Authorization", bearer());

    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);

    for (const template of response.body.data) {
      expect(Object.keys(template).sort()).toEqual(
        ["devPort", "id", "label", "previewPorts", "startCommand"].sort(),
      );
      // `image` and `filesDir` describe the host's layout and its Docker tags.
      expect(template).not.toHaveProperty("image");
      expect(template).not.toHaveProperty("filesDir");
    }
  });
});

describe("getProjectTree", () => {
  it("checks visitor access, then returns the tree", async () => {
    // `visitor`, not `viewer`, and deliberately: reading the files is exactly
    // what a PUBLIC project offers a stranger. Every other project endpoint
    // still asks for viewer or higher, so this is the narrow opening rather
    // than a general one.
    fileTreeService.buildFileTree.mockResolvedValue({ name: "app", children: [] });

    const response = await request(app)
      .get(`/projects/${TEST_PROJECT}/tree`)
      .set("Authorization", bearer());

    expect(response.status).toBe(200);
    expect(projectService.assertProjectAccess).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "visitor",
    );
  });

  it.each([
    ["not-a-uuid"],
    ["../../etc/passwd"],
    ["3f2504e0-4f89-41d3-9a0c-0305e82c33"],
  ])("rejects the project id %s before touching the filesystem", async (projectId) => {
    const response = await request(app)
      .get(`/projects/${encodeURIComponent(projectId)}/tree`)
      .set("Authorization", bearer());

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_PROJECT_ID");
    expect(fileTreeService.buildFileTree).not.toHaveBeenCalled();
    expect(projectService.assertProjectAccess).not.toHaveBeenCalled();
  });

  it("relays a 403 from the access check", async () => {
    projectService.assertProjectAccess.mockRejectedValue(new ForbiddenError());

    const response = await request(app)
      .get(`/projects/${TEST_PROJECT}/tree`)
      .set("Authorization", bearer());

    expect(response.status).toBe(403);
    expect(fileTreeService.buildFileTree).not.toHaveBeenCalled();
  });

  it("relays a 404 for a project that does not exist", async () => {
    projectService.assertProjectAccess.mockRejectedValue(new NotFoundError());

    const response = await request(app)
      .get(`/projects/${TEST_PROJECT}/tree`)
      .set("Authorization", bearer());

    expect(response.status).toBe(404);
  });
});

describe("getProjectPorts", () => {
  it("reports the template's dev port first, then its extras", async () => {
    projectService.assertProjectAccess.mockResolvedValue({
      ...PROJECT,
      template: "python-flask",
    });

    const response = await request(app)
      .get(`/projects/${TEST_PROJECT}/ports`)
      .set("Authorization", bearer());

    expect(response.status).toBe(200);
    expect(response.body.data.devPort).toBe(5000);
    expect(response.body.data.ports[0]).toBe(5000);
    expect(response.body.data.ports).toContain(8080);
  });
});

describe("project environment variables", () => {
  /** Read-only access to a project is not the same as being trusted with its
   *  credentials, which is why this asks for editor rather than viewer. */
  it("requires editor access to READ env vars", async () => {
    projectEnvService.getEnvVars.mockResolvedValue({ API_KEY: "secret" });

    await request(app).get(`/projects/${TEST_PROJECT}/env`).set("Authorization", bearer());

    expect(projectService.assertProjectAccess).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "editor",
    );
  });

  it("does not return env vars to a viewer", async () => {
    projectService.assertProjectAccess.mockRejectedValue(new ForbiddenError());

    const response = await request(app)
      .get(`/projects/${TEST_PROJECT}/env`)
      .set("Authorization", bearer());

    expect(response.status).toBe(403);
    expect(projectEnvService.getEnvVars).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });

  it("saves env vars and says they need a restart to take effect", async () => {
    projectEnvService.setEnvVars.mockResolvedValue({ API_KEY: "new" });

    const response = await request(app)
      .put(`/projects/${TEST_PROJECT}/env`)
      .set("Authorization", bearer())
      .send({ vars: { API_KEY: "new" } });

    expect(response.status).toBe(200);
    expect(projectEnvService.setEnvVars).toHaveBeenCalledWith(TEST_PROJECT, {
      API_KEY: "new",
    });
    expect(response.body.message).toMatch(/restart/i);
  });

  it("treats a body with no vars as an empty set rather than failing", async () => {
    projectEnvService.setEnvVars.mockResolvedValue({});

    const response = await request(app)
      .put(`/projects/${TEST_PROJECT}/env`)
      .set("Authorization", bearer())
      .send({});

    expect(response.status).toBe(200);
    expect(projectEnvService.setEnvVars).toHaveBeenCalledWith(TEST_PROJECT, {});
  });
});

describe("renameProjectController", () => {
  it("renames on behalf of the caller", async () => {
    projectService.renameProjectService.mockResolvedValue({ ...PROJECT, name: "new" });

    const response = await request(app)
      .patch(`/projects/${TEST_PROJECT}`)
      .set("Authorization", bearer())
      .send({ name: "  new  " });

    expect(response.status).toBe(200);
    // Trimmed by the schema, so a name of spaces cannot be smuggled through.
    expect(projectService.renameProjectService).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "new",
    );
  });

  it.each([[{}], [{ name: "" }], [{ name: "   " }], [{ name: "x".repeat(101) }]])(
    "rejects %o",
    async (body) => {
      const response = await request(app)
        .patch(`/projects/${TEST_PROJECT}`)
        .set("Authorization", bearer())
        .send(body);

      expect(response.status).toBe(400);
      expect(projectService.renameProjectService).not.toHaveBeenCalled();
    },
  );
});

describe("duplicateProjectController", () => {
  it("answers 201 with the copy", async () => {
    projectService.duplicateProjectService.mockResolvedValue({ ...PROJECT, id: "copy" });

    const response = await request(app)
      .post(`/projects/${TEST_PROJECT}/duplicate`)
      .set("Authorization", bearer())
      .send({ name: "copy" });

    expect(response.status).toBe(201);
    expect(projectService.duplicateProjectService).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "copy",
    );
  });
});

describe("deleteProjectController", () => {
  it("deletes on behalf of the caller", async () => {
    projectService.deleteProjectService.mockResolvedValue(undefined);

    const response = await request(app)
      .delete(`/projects/${TEST_PROJECT}`)
      .set("Authorization", bearer());

    expect(response.status).toBe(200);
    expect(projectService.deleteProjectService).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
    );
  });

  it("rejects an invalid project id without calling the service", async () => {
    const response = await request(app)
      .delete("/projects/nonsense")
      .set("Authorization", bearer());

    expect(response.status).toBe(400);
    expect(projectService.deleteProjectService).not.toHaveBeenCalled();
  });
});
