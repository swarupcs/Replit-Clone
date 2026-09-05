import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The guard that makes retrying safe.
 *
 *  `retryScaffold` empties the project's working tree and removes its
 *  container. Nothing in that function decides whether it SHOULD — the rule
 *  lives here, one file away, and says the project has to be FAILED. Those two
 *  cannot be read together, which is exactly why both ends are pinned:
 *  scaffoldService.test.ts covers what the deletion does, and this covers when
 *  it is allowed to happen at all.
 *
 *  Retrying a READY project would delete a project that works. Retrying one
 *  already SCAFFOLDING would run two scaffolders over the same directory.
 */

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("../lib/prisma.js", () => ({
  prisma: { project: { findUnique } },
}));

const retryScaffold = vi.hoisted(() => vi.fn());
const templatesWithRecipes = vi.hoisted(() => vi.fn(() => Promise.resolve(new Set())));
vi.mock("../service/scaffoldService.js", () => ({
  retryScaffold,
  templatesWithRecipes,
}));

const assertProjectAccess = vi.hoisted(() => vi.fn());
vi.mock("../service/projectAccessService.js", () => ({
  assertProjectAccess,
  listAccessibleProjects: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
}));

import { retryScaffoldController } from "./projectController.js";
import { apiApp, bearer, TEST_PROJECT } from "../test/apiHarness.js";

const app = apiApp([
  {
    method: "post",
    path: "/projects/:projectId/scaffold/retry",
    handler: retryScaffoldController,
  },
]);

function retry() {
  return request(app)
    .post(`/projects/${TEST_PROJECT}/scaffold/retry`)
    .set("Authorization", bearer());
}

beforeEach(() => {
  vi.clearAllMocks();
  assertProjectAccess.mockResolvedValue(undefined);
  findUnique.mockResolvedValue({
    template: "react-vite",
    scaffoldStatus: "FAILED",
  });
  retryScaffold.mockResolvedValue(true);
});

describe("retrying a scaffold", () => {
  it("starts again when the project failed", async () => {
    const response = await retry();

    expect(response.status).toBe(200);
    expect(retryScaffold).toHaveBeenCalledWith(TEST_PROJECT, "react-vite");
  });

  /** The one that would destroy somebody's work. */
  it("refuses a project that is working, and deletes nothing", async () => {
    findUnique.mockResolvedValue({
      template: "react-vite",
      scaffoldStatus: "READY",
    });

    const response = await retry();

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("NOT_FAILED");
    expect(retryScaffold).not.toHaveBeenCalled();
  });

  /** Two scaffolders over one directory is a race with no winner. */
  it("refuses one that is already being built", async () => {
    findUnique.mockResolvedValue({
      template: "react-vite",
      scaffoldStatus: "SCAFFOLDING",
    });

    const response = await retry();

    expect(response.status).toBe(400);
    expect(retryScaffold).not.toHaveBeenCalled();
  });

  /** Emptying the tree is not a collaborator's call to make. Asserted rather
   *  than assumed, because "owner" here and "editor" elsewhere on this router
   *  differ by one word. */
  it("is the owner's decision, not an editor's", async () => {
    await retry();

    expect(assertProjectAccess).toHaveBeenCalledWith(
      TEST_PROJECT,
      expect.any(String),
      "owner",
    );
  });

  it("is a 404 for a project that is not there", async () => {
    findUnique.mockResolvedValue(null);

    expect((await retry()).status).toBe(404);
    expect(retryScaffold).not.toHaveBeenCalled();
  });

  /** A recipe turned off upstream leaves a FAILED project with nothing to run.
   *  Saying so beats a retry that silently does nothing. */
  it("says plainly when the template has no recipe left", async () => {
    retryScaffold.mockResolvedValue(false);

    const response = await retry();

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("NO_RECIPE");
  });
});
