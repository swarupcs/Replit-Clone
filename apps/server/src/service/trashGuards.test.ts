import { beforeEach, describe, expect, it, vi } from "vitest";

/** Where a trashed project is stopped, and why it is more than one place.
 *
 *  §2.20 is the record of what happens when a state on a column reaches some
 *  of its surfaces and not others: the takedown filtered three queries, and a
 *  sweep found four more that had never been told — a copy, a share link, a
 *  nightly job and a rebuild. A trash has the same shape and a larger blast
 *  radius, so these tests are written per surface rather than per feature.
 *
 *  The first one is the important one. `getProjectAccess` is what every route
 *  and every socket handler reaches a project through, so one line there
 *  covers the whole authenticated product — which is exactly why it needs a
 *  test naming it, rather than the confidence that comes from having written
 *  it recently.
 */

const findUnique = vi.hoisted(() => vi.fn());
const findMany = vi.hoisted(() => vi.fn());
const findFirst = vi.hoisted(() => vi.fn());

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findUnique, findMany, findFirst },
    projectEmbed: { findFirst },
    scheduledJob: { findMany },
    deployment: { findFirst },
  },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  getProjectAccess,
  listAccessibleProjects,
  listPublicProjects,
  redeemShareToken,
} from "./projectAccessService.js";

const PROJECT = "7e1c4b02-9a3d-4f18-8b6e-2d5a7c9e0f31";
const OWNER = "11111111-1111-4111-8111-111111111111";

function project(over: Record<string, unknown> = {}) {
  return {
    id: PROJECT,
    ownerId: OWNER,
    visibility: "PUBLIC",
    takenDownAt: null,
    deletedAt: null,
    collaborators: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  findFirst.mockResolvedValue(null);
});

describe("the one guard that covers the authenticated product", () => {
  it("reports a trashed project as missing, even to its owner", async () => {
    findUnique.mockResolvedValue(project({ deletedAt: new Date() }));

    // Null is what `assertProjectAccess` turns into a 404, which is also the
    // honest answer: the owner deleted it. Restoring is the one operation that
    // looks past this, and it says so.
    expect(await getProjectAccess(PROJECT, OWNER)).toBeNull();
  });

  /** A trashed public project must not keep answering as one: `visitor` is
   *  granted from `visibility` alone, so this is the path a stranger takes. */
  it("reports it as missing to a stranger too", async () => {
    findUnique.mockResolvedValue(project({ deletedAt: new Date() }));

    expect(await getProjectAccess(PROJECT, "someone-else")).toBeNull();
  });

  it("still answers normally for a project that is not in the trash", async () => {
    findUnique.mockResolvedValue(project());

    expect((await getProjectAccess(PROJECT, OWNER))?.level).toBe("owner");
  });
});

describe("the surfaces that never see a session", () => {
  it("keeps a trashed project out of the dashboard's list", async () => {
    await listAccessibleProjects(OWNER);

    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { deletedAt: null },
    });
  });

  it("keeps it out of the public gallery", async () => {
    await listPublicProjects();

    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { deletedAt: null },
    });
  });

  /** A bearer string that was pasted somewhere is the surface §2.20 found
   *  twice. The token is cleared on delete AND the query filters, which is
   *  decision 13: the cleanup can be missed and the clause cannot. */
  it("stops a share link redeeming into it", async () => {
    await redeemShareToken("tok", OWNER).catch(() => undefined);

    expect(findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { deletedAt: null },
    });
  });
});
