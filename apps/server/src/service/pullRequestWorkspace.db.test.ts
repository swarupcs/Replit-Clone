import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { dbScope } from "../test/dbScope.js";

/** The §13.3 rows against real Postgres.
 *
 *  §5 records two migrations that shipped green having never been run, because
 *  they wrote the model name where the mapped table name belonged and nothing
 *  but Postgres reads a migration. A round trip through the generated client is
 *  the check that catches that class: it fails if the table, the schema and the
 *  client disagree in any direction. Set TEST_DATABASE_URL; CI always does.
 */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe.skipIf(!TEST_DATABASE_URL)("pull request workspaces", () => {
  const scope = dbScope("pr-workspace");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let userId: string;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ prisma } = await import("../lib/prisma.js"));
  });

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: { email: scope.email("owner"), passwordHash: "x" },
    });
    userId = user.id;
  });

  afterEach(async () => {
    await scope.cleanup(prisma);
  });

  async function project(name = "widget-pr-1") {
    return prisma.project.create({ data: { name, ownerId: userId } });
  }

  async function workspace(number: number, overrides: Record<string, unknown> = {}) {
    const created = await project(`widget-pr-${String(number)}`);
    return prisma.pullRequestWorkspace.create({
      data: {
        owner: "acme",
        repo: "widget",
        number,
        headRef: "feature",
        headSha: "a".repeat(40),
        projectId: created.id,
        ...overrides,
      },
    });
  }

  it("stores and reads a workspace back", async () => {
    const row = await workspace(1);
    const found = await prisma.pullRequestWorkspace.findUnique({ where: { id: row.id } });

    expect(found?.owner).toBe("acme");
    expect(found?.number).toBe(1);
    expect(found?.commentId).toBeNull();
  });

  it("allows one workspace per pull request and refuses a second", async () => {
    // The unique index is what makes a redelivered `opened` a no-op rather
    // than a second container.
    await workspace(2);
    const other = await project("widget-pr-2-again");

    await expect(
      prisma.pullRequestWorkspace.create({
        data: {
          owner: "acme",
          repo: "widget",
          number: 2,
          headRef: "feature",
          headSha: "b".repeat(40),
          projectId: other.id,
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses two workspaces pointing at one project", async () => {
    const row = await workspace(3);

    await expect(
      prisma.pullRequestWorkspace.create({
        data: {
          owner: "acme",
          repo: "other",
          number: 9,
          headRef: "feature",
          headSha: "c".repeat(40),
          projectId: row.projectId,
        },
      }),
    ).rejects.toThrow();
  });

  it("goes away with the project it points at", async () => {
    const row = await workspace(4);
    await prisma.project.delete({ where: { id: row.projectId } });

    expect(await prisma.pullRequestWorkspace.findUnique({ where: { id: row.id } })).toBeNull();
  });

  it("finds a workspace by the key a webhook actually has", async () => {
    await workspace(5);

    const found = await prisma.pullRequestWorkspace.findUnique({
      where: { owner_repo_number: { owner: "acme", repo: "widget", number: 5 } },
    });

    expect(found).not.toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("repository enrolment", () => {
  const scope = dbScope("pr-repo");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let userId: string;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ prisma } = await import("../lib/prisma.js"));
  });

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: { email: scope.email("owner"), passwordHash: "x" },
    });
    userId = user.id;
  });

  afterEach(async () => {
    await scope.cleanup(prisma);
  });

  it("refuses a second account claiming the same repository", async () => {
    // "Whose quota does this spend" must have one answer.
    const repo = `widget-${randomUUID().slice(0, 8)}`;
    await prisma.pullRequestRepo.create({ data: { owner: "acme", repo, userId } });

    const other = await prisma.user.create({
      data: { email: scope.email("other"), passwordHash: "x" },
    });

    await expect(
      prisma.pullRequestRepo.create({ data: { owner: "acme", repo, userId: other.id } }),
    ).rejects.toThrow();
  });

  it("goes away with the account that enrolled it", async () => {
    const repo = `widget-${randomUUID().slice(0, 8)}`;
    const row = await prisma.pullRequestRepo.create({ data: { owner: "acme", repo, userId } });

    await prisma.user.delete({ where: { id: userId } });

    expect(await prisma.pullRequestRepo.findUnique({ where: { id: row.id } })).toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("delivery claims", () => {
  let prisma: typeof import("../lib/prisma.js").prisma;
  let service: typeof import("./prWorkspaceService.js");

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ prisma } = await import("../lib/prisma.js"));
    service = await import("./prWorkspaceService.js");
  });

  it("claims a delivery once and refuses the replay", async () => {
    // Not an efficiency measure: GitHub's signature carries no timestamp, so
    // a captured delivery stays valid forever and this is the only replay
    // defence there is.
    const id = `delivery-${randomUUID()}`;

    expect(await service.claimDelivery(id, "pull_request")).toBe(true);
    expect(await service.claimDelivery(id, "pull_request")).toBe(false);

    await prisma.webhookDelivery.delete({ where: { id } });
  });
});
