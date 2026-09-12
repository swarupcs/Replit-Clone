import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbScope } from "../test/dbScope.js";

/** §13.4's rows against real Postgres.
 *
 *  The env layering is the half a mocked Prisma cannot answer honestly: it is a
 *  question about what three columns produce together, and §5's defect class is
 *  exactly the kind that only a real table shows.
 */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe.skipIf(!TEST_DATABASE_URL)("several checkouts of one repository", () => {
  const scope = dbScope("workspace-group");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let groups: typeof import("./workspaceGroupService.js");
  let envService: typeof import("./projectEnvService.js");

  let userId: string;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ prisma } = await import("../lib/prisma.js"));
    groups = await import("./workspaceGroupService.js");
    envService = await import("./projectEnvService.js");
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

  async function project(name: string) {
    return prisma.project.create({ data: { name, ownerId: userId } });
  }

  it("makes one group for a repository, however often it is asked for", async () => {
    const first = await groups.groupFor(userId, "acme", "widget");
    const second = await groups.groupFor(userId, "acme", "widget");

    expect(second.id).toBe(first.id);
  });

  it("treats the repository name case-insensitively", async () => {
    // GitHub sends whichever case the event carried, and a case-sensitive key
    // would open a second group for the same repository.
    const first = await groups.groupFor(userId, "acme", "widget");
    const second = await groups.groupFor(userId, "ACME", "Widget");

    expect(second.id).toBe(first.id);
  });

  it("gives two people their own group for one repository", async () => {
    const other = await prisma.user.create({
      data: { email: scope.email("other"), passwordHash: "x" },
    });

    const mine = await groups.groupFor(userId, "acme", "widget");
    const theirs = await groups.groupFor(other.id, "acme", "widget");

    expect(theirs.id).not.toBe(mine.id);
  });

  it("lists a repository once with its checkouts under it", async () => {
    const main = await project("widget");
    const review = await project("widget-review");
    await groups.joinGroup(main.id, userId, "acme", "widget");
    await groups.joinGroup(review.id, userId, "acme", "widget");

    const listed = await groups.listGroups(userId);

    expect(listed).toHaveLength(1);
    expect(listed[0]?.checkouts.map((c) => c.id).sort()).toEqual([main.id, review.id].sort());
  });

  it("does not list a trashed checkout", async () => {
    const main = await project("widget");
    const gone = await project("widget-old");
    await groups.joinGroup(main.id, userId, "acme", "widget");
    await groups.joinGroup(gone.id, userId, "acme", "widget");
    await prisma.project.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });

    const listed = await groups.listGroups(userId);

    expect(listed[0]?.checkouts.map((c) => c.id)).toEqual([main.id]);
  });

  it("finds the other checkouts of one repository", async () => {
    const main = await project("widget");
    const review = await project("widget-review");
    await groups.joinGroup(main.id, userId, "acme", "widget");
    await groups.joinGroup(review.id, userId, "acme", "widget");

    const siblings = await groups.siblingsOf(main.id);

    expect(siblings.map((p) => p.id)).toEqual([review.id]);
  });

  it("reports no siblings for a project in no group", async () => {
    const alone = await project("unrelated");
    expect(await groups.siblingsOf(alone.id)).toEqual([]);
  });

  it("KEEPS the checkouts when the group is dissolved", async () => {
    // SET NULL and not CASCADE: grouping is not owning, and dissolving a group
    // must not delete the work in it.
    const main = await project("widget");
    const group = await groups.groupFor(userId, "acme", "widget");
    await groups.joinGroup(main.id, userId, "acme", "widget");

    await prisma.workspaceGroup.delete({ where: { id: group.id } });

    const survivor = await prisma.project.findUnique({ where: { id: main.id } });
    expect(survivor).not.toBeNull();
    expect(survivor?.groupId).toBeNull();
  });

  describe("the shared environment", () => {
    it("reaches every checkout of the repository", async () => {
      const main = await project("widget");
      const group = await groups.groupFor(userId, "acme", "widget");
      await groups.joinGroup(main.id, userId, "acme", "widget");
      await groups.setGroupEnvVars(group.id, userId, { SHARED: "from-the-group" });

      expect((await envService.getEnvVars(main.id))["SHARED"]).toBe("from-the-group");
    });

    it("loses to the checkout's own value, which is more specific", async () => {
      const main = await project("widget");
      const group = await groups.groupFor(userId, "acme", "widget");
      await groups.joinGroup(main.id, userId, "acme", "widget");
      await groups.setGroupEnvVars(group.id, userId, { API_URL: "group" });
      await envService.setEnvVars(main.id, { API_URL: "checkout" });

      expect((await envService.getEnvVars(main.id))["API_URL"]).toBe("checkout");
    });

    it("beats the account's value, which is less specific", async () => {
      const accountSecrets = await import("./accountSecretService.js");
      const main = await project("widget");
      const group = await groups.groupFor(userId, "acme", "widget");
      await groups.joinGroup(main.id, userId, "acme", "widget");

      await accountSecrets.setAccountSecrets(userId, { TOKEN: "account" });
      await groups.setGroupEnvVars(group.id, userId, { TOKEN: "group" });

      expect((await envService.getEnvVars(main.id))["TOKEN"]).toBe("group");
    });

    it("does not reach a project in no group", async () => {
      const alone = await project("unrelated");
      const group = await groups.groupFor(userId, "acme", "widget");
      await groups.setGroupEnvVars(group.id, userId, { SHARED: "nope" });

      expect((await envService.getEnvVars(alone.id))["SHARED"]).toBeUndefined();
    });

    it("refuses to be written through somebody else's account", async () => {
      const other = await prisma.user.create({
        data: { email: scope.email("other"), passwordHash: "x" },
      });
      const group = await groups.groupFor(userId, "acme", "widget");

      await expect(
        groups.setGroupEnvVars(group.id, other.id, { SNEAK: "1" }),
      ).rejects.toThrow();
    });

    it("stores ciphertext rather than the value, when sealing is configured", async () => {
      const group = await groups.groupFor(userId, "acme", "widget");
      await groups.setGroupEnvVars(group.id, userId, { TOKEN: "a-real-looking-secret" });

      const row = await prisma.workspaceGroup.findUnique({ where: { id: group.id } });
      const raw = JSON.stringify(row?.envVars);

      // Only asserted when this deployment can seal at all — the same condition
      // the project-level suite uses.
      if (envService.envVarsEncryptedAtRest()) {
        expect(raw).not.toContain("a-real-looking-secret");
      }
      expect((await groups.groupEnvVars(group.id))["TOKEN"]).toBe("a-real-looking-secret");
    });
  });
});
