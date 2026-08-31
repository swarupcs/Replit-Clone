import { beforeEach, describe, expect, it, vi } from "vitest";

/** Notifications, at the level that does not need a database.
 *
 *  What is worth pinning here is the DELIVERY policy, because every rule in it
 *  is one that a reasonable person would implement the other way round and
 *  only discover was wrong in production: mail that goes to an unverified
 *  address, a failed send that takes the job run down with it, an empty
 *  ADMIN_EMAILS that silently means nobody is told.
 */

/** Typed with its real parameter, not as `vi.fn(() => ...)`: without it
 *  `mock.calls[0]` is a zero-length tuple and every assertion about what was
 *  actually sent is a type error rather than a test. */
const send = vi.hoisted(() =>
  vi.fn((_mail: { to: string; subject: string; text: string }) =>
    Promise.resolve(),
  ),
);
const hasRealMailer = vi.hoisted(() => vi.fn(() => true));
const admins = vi.hoisted(() => vi.fn(() => new Set<string>(["mod@example.com"])));

vi.mock("../lib/mailer.js", () => ({
  getMailer: () => ({ send }),
  hasRealMailer,
  webUrl: (path: string) => `https://app.test${path}`,
}));

vi.mock("../middlewares/requireAdmin.js", () => ({
  adminEmails: admins,
}));

const notificationCreate = vi.hoisted(() => vi.fn());
const notificationUpdate = vi.hoisted(() => vi.fn());
const notificationFindMany = vi.hoisted(() => vi.fn());
const notificationDeleteMany = vi.hoisted(() => vi.fn());
const userFindUnique = vi.hoisted(() => vi.fn());

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    notification: {
      create: notificationCreate,
      update: notificationUpdate,
      findMany: notificationFindMany,
      deleteMany: notificationDeleteMany,
    },
    user: { findUnique: userFindUnique },
  },
}));

const warn = vi.hoisted(() => vi.fn());
const error = vi.hoisted(() => vi.fn());
vi.mock("../lib/logger.js", () => ({
  logger: { warn, error, info: vi.fn(), debug: vi.fn() },
}));

import { notify, notifyAdmins } from "./notificationService.js";

const VERIFIED = { email: "her@example.com", emailVerifiedAt: new Date() };

const news = {
  userId: "u1",
  kind: "JOB_FAILING" as const,
  title: "\"Nightly backup\" is failing",
  body: "It exited non-zero.",
  link: "/project/p1?view=jobs",
};

beforeEach(() => {
  send.mockReset().mockResolvedValue(undefined);
  hasRealMailer.mockReset().mockReturnValue(true);
  admins.mockReset().mockReturnValue(new Set(["mod@example.com"]));
  notificationCreate.mockReset().mockResolvedValue({ id: "n1" });
  notificationUpdate.mockReset().mockResolvedValue({});
  notificationFindMany.mockReset().mockResolvedValue([]);
  notificationDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  userFindUnique.mockReset().mockResolvedValue(VERIFIED);
  warn.mockReset();
  error.mockReset();
});

describe("notify", () => {
  it("records the notification and then mails it", async () => {
    await expect(notify(news)).resolves.toBe("n1");

    expect(notificationCreate).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    // The link is absolute in mail, because mail is read outside the app.
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      to: "her@example.com",
      subject: news.title,
    });
    expect(String(send.mock.calls[0]?.[0]?.text)).toContain(
      "https://app.test/project/p1?view=jobs",
    );
  });

  it("records it even when there is no mailer at all", async () => {
    // The record IS the feature. An install without SMTP still tells its users
    // things; it just tells them in the app.
    hasRealMailer.mockReturnValue(false);

    await expect(notify(news)).resolves.toBe("n1");
    expect(notificationCreate).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not mail an unverified address", async () => {
    // Signing up does not prove you own what you typed. `emailVerifiedAt`
    // exists so somebody else's project news is not sent to an address that
    // may not be theirs -- the record is still written.
    userFindUnique.mockResolvedValue({
      email: "maybe-not-hers@example.com",
      emailVerifiedAt: null,
    });

    await expect(notify(news)).resolves.toBe("n1");
    expect(notificationCreate).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the record when the mail fails, and does not throw", async () => {
    send.mockRejectedValue(new Error("smtp is down"));

    await expect(notify(news)).resolves.toBe("n1");
    expect(notificationUpdate).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it("never throws at its caller when nothing can be stored", async () => {
    // This is the load-bearing one. A notification is a side effect of work
    // that already happened -- a job that already ran, a project already made
    // private -- and failing that work because the announcement could not be
    // written would be the tail wagging the dog.
    notificationCreate.mockRejectedValue(new Error("the database is gone"));

    await expect(notify(news)).resolves.toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it("marks the row as mailed only when a send actually happened", async () => {
    await notify(news);
    expect(notificationUpdate).toHaveBeenCalledOnce();

    notificationUpdate.mockClear();
    hasRealMailer.mockReturnValue(false);
    await notify(news);
    expect(notificationUpdate).not.toHaveBeenCalled();
  });
});

describe("notifyAdmins", () => {
  it("mails every configured moderator", async () => {
    admins.mockReturnValue(new Set(["a@example.com", "b@example.com"]));

    await notifyAdmins({ subject: "Project reported", text: "have a look" });

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("says so loudly when ADMIN_EMAILS is empty", async () => {
    // A queue nobody is told about is the exact condition this work exists to
    // end, and it must not be reachable by leaving a variable unset and
    // hearing nothing back.
    admins.mockReturnValue(new Set());

    await notifyAdmins({ subject: "Project reported", text: "have a look" });

    expect(send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("one bad address does not cost the others their mail", async () => {
    admins.mockReturnValue(new Set(["bad@example.com", "good@example.com"]));
    send.mockRejectedValueOnce(new Error("no such mailbox"));

    await notifyAdmins({ subject: "Project reported", text: "have a look" });

    expect(send).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledOnce();
  });

  it("writes no in-app record, because a moderator may have no account", async () => {
    await notifyAdmins({ subject: "Project reported", text: "have a look" });
    expect(notificationCreate).not.toHaveBeenCalled();
  });
});
