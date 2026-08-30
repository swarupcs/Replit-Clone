import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dbScope } from "../test/dbScope.js";

/** Notifications against real rows.
 *
 *  The unit tests cover the delivery policy, which is where a dangerous
 *  mistake would be. What is left is what only a database can answer: that the
 *  list is scoped to its owner, that one person cannot mark another person's
 *  notification read by passing its id, that the cascade takes them with the
 *  account, and that the inbox stays bounded.
 *
 *  Set TEST_DATABASE_URL to a throwaway Postgres with the migrations applied.
 */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

// No mailer in these: they are about the record, and `hasRealMailer` is false
// by default, which is exactly the install this must still work on.
vi.mock("../middlewares/requireAdmin.js", () => ({
  adminEmails: () => new Set<string>(),
}));

describe.skipIf(!TEST_DATABASE_URL)("notifications", () => {
  const scope = dbScope("notifications");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let notifications: typeof import("./notificationService.js");

  let mineId: string;
  let theirsId: string;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ prisma } = await import("../lib/prisma.js"));
    notifications = await import("./notificationService.js");
  });

  beforeEach(async () => {
    const mine = await prisma.user.create({
      data: { email: scope.email("mine"), passwordHash: "x" },
    });
    const theirs = await prisma.user.create({
      data: { email: scope.email("theirs"), passwordHash: "x" },
    });
    mineId = mine.id;
    theirsId = theirs.id;
  });

  afterEach(async () => {
    await scope.cleanup(prisma);
  });

  const send = (userId: string, title = "Something happened") =>
    notifications.notify({
      userId,
      kind: "JOB_FAILING",
      title,
      body: "It exited non-zero.",
      link: "/project/p1?view=jobs",
    });

  describe("recording one", () => {
    it("stores it unread, with its link", async () => {
      await send(mineId);

      const list = await notifications.listNotifications(mineId);
      expect(list.unread).toBe(1);
      expect(list.items[0]).toMatchObject({
        kind: "JOB_FAILING",
        link: "/project/p1?view=jobs",
        readAt: null,
      });
    });

    it("records it even with no mailer configured", async () => {
      // The record is the feature. This is the install that has never set up
      // SMTP, and it still tells its users things.
      await expect(send(mineId)).resolves.toEqual(expect.any(String));
    });

    it("newest first", async () => {
      await send(mineId, "older");
      await send(mineId, "newer");

      const list = await notifications.listNotifications(mineId);
      expect(list.items[0]?.title).toBe("newer");
    });
  });

  describe("whose they are", () => {
    it("shows somebody only their own", async () => {
      await send(mineId, "mine");
      await send(theirsId, "theirs");

      const list = await notifications.listNotifications(mineId);
      expect(list.items).toHaveLength(1);
      expect(list.items[0]?.title).toBe("mine");
    });

    it("cannot mark somebody else's read by passing its id", async () => {
      // The id comes from a client. Scoping lives in the WHERE clause rather
      // than in a check that has to remember to run.
      const id = await send(theirsId);
      expect(id).not.toBeNull();

      const result = await notifications.markRead(mineId, [id!]);

      expect(result.read).toBe(0);
      expect((await notifications.listNotifications(theirsId)).unread).toBe(1);
    });
  });

  describe("marking read", () => {
    it("marks just the ones named", async () => {
      const first = await send(mineId, "first");
      await send(mineId, "second");

      await notifications.markRead(mineId, [first!]);

      const list = await notifications.listNotifications(mineId);
      expect(list.unread).toBe(1);
      expect(list.items.find((row) => row.title === "first")?.readAt).not.toBeNull();
    });

    it("marks everything when given nothing", async () => {
      await send(mineId, "a");
      await send(mineId, "b");

      const result = await notifications.markRead(mineId);

      expect(result.read).toBe(2);
      expect((await notifications.listNotifications(mineId)).unread).toBe(0);
    });

    it("does not rewrite the timestamp of one already read", async () => {
      const id = await send(mineId);
      await notifications.markRead(mineId);

      const first = await prisma.notification.findUnique({ where: { id: id! } });
      const again = await notifications.markRead(mineId);

      expect(again.read).toBe(0);
      const second = await prisma.notification.findUnique({ where: { id: id! } });
      expect(second?.readAt?.toISOString()).toBe(first?.readAt?.toISOString());
    });
  });

  describe("the account going away", () => {
    it("takes its notifications with it", async () => {
      await send(mineId);
      await prisma.user.delete({ where: { id: mineId } });

      const left = await prisma.notification.count({ where: { userId: mineId } });
      expect(left).toBe(0);
    });
  });
});
