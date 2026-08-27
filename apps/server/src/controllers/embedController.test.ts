import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  createEmbed: vi.fn(),
  embedFile: vi.fn(),
  embedPayload: vi.fn(),
  embedState: vi.fn(),
  revokeEmbed: vi.fn(),
  updateEmbed: vi.fn(),
}));
const access = vi.hoisted(() => ({ assertProjectAccess: vi.fn() }));

vi.mock("../service/embedService.js", () => service);
vi.mock("../service/projectAccessService.js", () => access);
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
}));

import {
  createEmbedController,
  getEmbedController,
  readEmbedController,
  readEmbedFileController,
  revokeEmbedController,
  updateEmbedController,
} from "./embedController.js";
import { apiApp, bearer, TEST_PROJECT } from "../test/apiHarness.js";
import { ForbiddenError, NotFoundError } from "../utils/errors.js";

/** Two apps, because the whole point of this feature is that half of it is
 *  authenticated and half of it deliberately is not. Mounting them together
 *  would test neither. */
const owner = apiApp([
  { method: "get", path: "/p/:projectId/embed", handler: getEmbedController },
  { method: "post", path: "/p/:projectId/embed", handler: createEmbedController },
  { method: "patch", path: "/p/:projectId/embed", handler: updateEmbedController },
  { method: "delete", path: "/p/:projectId/embed", handler: revokeEmbedController },
]);

const publicApp = apiApp(
  [
    { method: "get", path: "/e/:token", handler: readEmbedController },
    { method: "get", path: "/e/:token/file", handler: readEmbedFileController },
  ],
  { auth: false },
);

const TOKEN = "a".repeat(43);
const auth = () => ({ Authorization: bearer() });

const STATE = {
  token: TOKEN,
  settings: { view: "split", preview: "deployment", activeFile: null },
  hasDeployment: true,
  hiddenPaths: [".env"],
};

beforeEach(() => {
  vi.clearAllMocks();
  access.assertProjectAccess.mockResolvedValue({ id: TEST_PROJECT });
  service.embedState.mockResolvedValue(STATE);
  service.createEmbed.mockResolvedValue(STATE);
  service.updateEmbed.mockResolvedValue(STATE);
  service.revokeEmbed.mockResolvedValue({ ...STATE, token: null });
});

describe("the owner's endpoints", () => {
  it("lets a viewer see that an embed exists", async () => {
    const response = await request(owner)
      .get(`/p/${TEST_PROJECT}/embed`)
      .set(auth());

    expect(response.status).toBe(200);
    expect(response.body.data.token).toBe(TOKEN);
    expect(access.assertProjectAccess).toHaveBeenCalledWith(
      TEST_PROJECT,
      expect.any(String),
      "viewer",
    );
  });

  it("requires the OWNER to create one, not an editor", async () => {
    // The same reasoning as deployments: this is the action that puts a
    // project's source in front of everybody, and write access to a file is
    // not consent to publish it.
    await request(owner).post(`/p/${TEST_PROJECT}/embed`).set(auth()).send({});

    expect(access.assertProjectAccess).toHaveBeenCalledWith(
      TEST_PROJECT,
      expect.any(String),
      "owner",
    );
  });

  it("says outright that creating one breaks the old snippet", async () => {
    const response = await request(owner)
      .post(`/p/${TEST_PROJECT}/embed`)
      .set(auth())
      .send({ view: "code" });

    expect(response.status).toBe(200);
    expect(response.body.message).toMatch(/no longer works/i);
    expect(service.createEmbed).toHaveBeenCalledWith(TEST_PROJECT, {
      view: "code",
    });
  });

  it("says the opposite for an update, which keeps the token", async () => {
    const response = await request(owner)
      .patch(`/p/${TEST_PROJECT}/embed`)
      .set(auth())
      .send({ view: "preview" });

    expect(response.body.message).toMatch(/already pasted/i);
  });

  it("refuses a view it does not know, rather than storing it", async () => {
    const response = await request(owner)
      .patch(`/p/${TEST_PROJECT}/embed`)
      .set(auth())
      .send({ view: "fullscreen" });

    expect(response.status).toBe(400);
    expect(service.updateEmbed).not.toHaveBeenCalled();
  });

  it("refuses a live-container preview at the edge", async () => {
    const response = await request(owner)
      .patch(`/p/${TEST_PROJECT}/embed`)
      .set(auth())
      .send({ preview: "live" });

    expect(response.status).toBe(400);
    expect(service.updateEmbed).not.toHaveBeenCalled();
  });

  it("turns a forbidden project into a forbidden response", async () => {
    access.assertProjectAccess.mockRejectedValue(new ForbiddenError("nope"));

    const response = await request(owner)
      .delete(`/p/${TEST_PROJECT}/embed`)
      .set(auth());

    expect(response.status).toBe(403);
  });

  it("needs a session at all", async () => {
    const response = await request(owner).get(`/p/${TEST_PROJECT}/embed`);
    expect(response.status).toBe(401);
  });
});

describe("what an anonymous reader calls", () => {
  beforeEach(() => {
    service.embedPayload.mockResolvedValue({
      projectName: "demo",
      template: "static-html",
      view: "split",
      activeFile: "index.html",
      files: [{ relPath: "index.html", size: 12 }],
      previewUrl: "http://quiet-fern.localhost:3102",
      projectUrl: "http://localhost:5273/project/x",
    });
    service.embedFile.mockResolvedValue({
      relPath: "index.html",
      contents: "<h1>hi</h1>",
      truncated: false,
    });
  });

  it("answers with no credential of any kind", async () => {
    // The feature is worthless if this ever needs a header.
    const response = await request(publicApp).get(`/e/${TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body.data.projectName).toBe("demo");
  });

  it("refuses to be cached, and refuses to be sniffed", async () => {
    // A shared cache holding a project's source after the owner revoked the
    // token would keep it readable past the moment they said stop.
    const response = await request(publicApp).get(`/e/${TOKEN}`);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("passes the path through as the reader sent it", async () => {
    await request(publicApp).get(`/e/${TOKEN}/file`).query({ path: "src/app.js" });

    expect(service.embedFile).toHaveBeenCalledWith(TOKEN, "src/app.js");
  });

  it("sends an empty path rather than an array when one is repeated", async () => {
    // `?path=a&path=b` arrives as an array, and an array reaching a path
    // resolver is how a check that assumes a string gets skipped.
    await request(publicApp)
      .get(`/e/${TOKEN}/file`)
      .query("path=a.js&path=b.js");

    expect(service.embedFile).toHaveBeenCalledWith(TOKEN, "");
  });

  it("reports a refused file as not found, with nothing else", async () => {
    service.embedFile.mockRejectedValue(new NotFoundError("No such file"));

    const response = await request(publicApp)
      .get(`/e/${TOKEN}/file`)
      .query({ path: ".env" });

    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain("env");
  });
});
