import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({
  getProjectAccess: vi.fn(),
  listCollaborators: vi.fn(),
  redeemShareToken: vi.fn(),
  removeCollaborator: vi.fn(),
  revokeShareToken: vi.fn(),
  rotateShareToken: vi.fn(),
  setCollaborator: vi.fn(),
  ProjectRole: { VIEWER: "VIEWER", EDITOR: "EDITOR" },
}));
const findUnique = vi.hoisted(() => vi.fn());

vi.mock("../service/projectAccessService.js", () => access);
vi.mock("../lib/prisma.js", () => ({ prisma: { project: { findUnique } } }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createShareLinkController,
  listSharingController,
  previewShareLinkController,
  redeemShareLinkController,
  removeCollaboratorController,
  revokeShareLinkController,
  setCollaboratorController,
} from "./sharingController.js";
import { apiApp, bearer, TEST_PROJECT, TEST_USER } from "../test/apiHarness.js";
import { ForbiddenError } from "../utils/errors.js";

const app = apiApp([
  { method: "get", path: "/p/share/preview", handler: previewShareLinkController },
  { method: "post", path: "/p/share/redeem", handler: redeemShareLinkController },
  { method: "get", path: "/p/:projectId/sharing", handler: listSharingController },
  { method: "put", path: "/p/:projectId/collaborators", handler: setCollaboratorController },
  {
    method: "delete",
    path: "/p/:projectId/collaborators/:userId",
    handler: removeCollaboratorController,
  },
  { method: "post", path: "/p/:projectId/share-link", handler: createShareLinkController },
  { method: "delete", path: "/p/:projectId/share-link", handler: revokeShareLinkController },
]);

const SECRET = "share-token-abcdef";
const auth = () => ({ Authorization: bearer() });

beforeEach(() => {
  vi.clearAllMocks();
  access.listCollaborators.mockResolvedValue([]);
});

describe("listSharingController", () => {
  it("shows the owner the share link itself", async () => {
    access.getProjectAccess.mockResolvedValue({
      level: "owner",
      project: { shareToken: SECRET },
    });
    access.listCollaborators.mockResolvedValue([{ userId: "u1", role: "EDITOR" }]);

    const response = await request(app).get(`/p/${TEST_PROJECT}/sharing`).set(auth());

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      level: "owner",
      collaborators: [{ userId: "u1", role: "EDITOR" }],
      shareToken: SECRET,
    });
  });

  /** Knowing the secret would let a collaborator re-share the project, which is
   *  the owner's call to make. */
  it.each([["editor"], ["viewer"]])("hides the share link from a %s", async (level) => {
    access.getProjectAccess.mockResolvedValue({
      level,
      project: { shareToken: SECRET },
    });

    const response = await request(app).get(`/p/${TEST_PROJECT}/sharing`).set(auth());

    expect(response.status).toBe(200);
    expect(response.body.data.shareToken).toBeNull();
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
  });

  it("reports 'none' when the user has no access record at all", async () => {
    access.getProjectAccess.mockResolvedValue(null);

    const response = await request(app).get(`/p/${TEST_PROJECT}/sharing`).set(auth());

    expect(response.body.data).toMatchObject({ level: "none", shareToken: null });
  });

  it("reports a null share token when the owner has never created one", async () => {
    access.getProjectAccess.mockResolvedValue({
      level: "owner",
      project: { shareToken: null },
    });

    const response = await request(app).get(`/p/${TEST_PROJECT}/sharing`).set(auth());

    expect(response.body.data.shareToken).toBeNull();
  });

  it("rejects an invalid project id", async () => {
    const response = await request(app).get("/p/nonsense/sharing").set(auth());

    expect(response.status).toBe(400);
    expect(access.listCollaborators).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    const response = await request(app).get(`/p/${TEST_PROJECT}/sharing`);

    expect(response.status).toBe(401);
    expect(access.listCollaborators).not.toHaveBeenCalled();
  });
});

describe("setCollaboratorController", () => {
  it.each([
    ["EDITOR", "EDITOR"],
    ["VIEWER", "VIEWER"],
  ])("adds a collaborator as %s", async (role, expected) => {
    access.setCollaborator.mockResolvedValue({ userId: "u2", role: expected });

    const response = await request(app)
      .put(`/p/${TEST_PROJECT}/collaborators`)
      .set(auth())
      .send({ email: "friend@example.com", role });

    expect(response.status).toBe(200);
    expect(access.setCollaborator).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "friend@example.com",
      expected,
    );
  });

  it("normalises the email before it reaches the service", async () => {
    access.setCollaborator.mockResolvedValue({});

    await request(app)
      .put(`/p/${TEST_PROJECT}/collaborators`)
      .set(auth())
      .send({ email: "  Friend@Example.COM  ", role: "VIEWER" });

    expect(access.setCollaborator).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "friend@example.com",
      "VIEWER",
    );
  });

  it.each([
    ["an unknown role", { email: "a@b.com", role: "OWNER" }],
    ["a lowercase role", { email: "a@b.com", role: "editor" }],
    ["no role", { email: "a@b.com" }],
    ["an invalid email", { email: "not-an-email", role: "VIEWER" }],
    ["no email", { role: "VIEWER" }],
  ])("rejects %s", async (_label, body) => {
    const response = await request(app)
      .put(`/p/${TEST_PROJECT}/collaborators`)
      .set(auth())
      .send(body);

    expect(response.status).toBe(400);
    expect(access.setCollaborator).not.toHaveBeenCalled();
  });

  it("relays a refusal from the service", async () => {
    access.setCollaborator.mockRejectedValue(new ForbiddenError("Only the owner can share"));

    const response = await request(app)
      .put(`/p/${TEST_PROJECT}/collaborators`)
      .set(auth())
      .send({ email: "a@b.com", role: "VIEWER" });

    expect(response.status).toBe(403);
  });
});

describe("removeCollaboratorController", () => {
  it("removes the named user on behalf of the caller", async () => {
    access.removeCollaborator.mockResolvedValue(undefined);

    const response = await request(app)
      .delete(`/p/${TEST_PROJECT}/collaborators/u2`)
      .set(auth());

    expect(response.status).toBe(200);
    expect(access.removeCollaborator).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "u2",
    );
  });
});

describe("share links", () => {
  it("creates a new link and says the old one has stopped working", async () => {
    access.rotateShareToken.mockResolvedValue(SECRET);

    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/share-link`)
      .set(auth());

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ shareToken: SECRET });
    // Rotating silently would be a nasty surprise for whoever holds the old one.
    expect(response.body.message).toMatch(/no longer works/i);
  });

  it("revokes a link and says existing collaborators keep their access", async () => {
    access.revokeShareToken.mockResolvedValue(undefined);

    const response = await request(app)
      .delete(`/p/${TEST_PROJECT}/share-link`)
      .set(auth());

    expect(response.status).toBe(200);
    expect(access.revokeShareToken).toHaveBeenCalledWith(TEST_PROJECT, TEST_USER.sub);
    expect(response.body.message).toMatch(/keep their access/i);
  });
});

describe("redeemShareLinkController", () => {
  it("grants the signed-in user access", async () => {
    access.redeemShareToken.mockResolvedValue({ id: TEST_PROJECT, name: "demo" });

    const response = await request(app)
      .post("/p/share/redeem")
      .set(auth())
      .send({ token: SECRET });

    expect(response.status).toBe(200);
    expect(access.redeemShareToken).toHaveBeenCalledWith(SECRET, TEST_USER.sub);
    expect(response.body.message).toContain("demo");
  });

  it.each([[{}], [{ token: "" }], [{ token: 42 }]])("rejects %o", async (body) => {
    const response = await request(app).post("/p/share/redeem").set(auth()).send(body);

    expect(response.status).toBe(400);
    expect(access.redeemShareToken).not.toHaveBeenCalled();
  });

  it("requires a signed-in user — a link grants access to somebody", async () => {
    const response = await request(app).post("/p/share/redeem").send({ token: SECRET });

    expect(response.status).toBe(401);
    expect(access.redeemShareToken).not.toHaveBeenCalled();
  });
});

describe("previewShareLinkController", () => {
  /** Deliberately minimal: enough to tell whether the link is the one you were
   *  expecting, and nothing else about the project or its owner. */
  it("returns only the project's name and template", async () => {
    findUnique.mockResolvedValue({ name: "demo", template: "react-vite" });

    const response = await request(app)
      .get("/p/share/preview")
      .query({ token: SECRET })
      .set(auth());

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ name: "demo", template: "react-vite" });
    expect(findUnique).toHaveBeenCalledWith({
      where: { shareToken: SECRET },
      select: { name: true, template: true },
    });
  });

  it("says the link is not valid rather than 404ing", async () => {
    findUnique.mockResolvedValue(null);

    const response = await request(app)
      .get("/p/share/preview")
      .query({ token: "wrong" })
      .set(auth());

    expect(response.status).toBe(200);
    expect(response.body.data).toBeNull();
    expect(response.body.message).toMatch(/not valid/i);
  });

  it.each([
    ["no token", {}],
    ["an empty token", { token: "" }],
  ])("does not query the database for %s", async (_label, query) => {
    const response = await request(app).get("/p/share/preview").query(query).set(auth());

    expect(response.status).toBe(200);
    expect(response.body.data).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
