import { beforeEach, describe, expect, it, vi } from "vitest";

/** One account, provisioned from the environment.
 *
 *  Two things are being pinned here and they pull in opposite directions.
 *
 *  The first is that turning the mode ON must actually close the door: no
 *  second account, by any route, including the two that make a `User` row.
 *  The second is that leaving it OFF must change nothing at all — this is a
 *  mode, and a mode that quietly alters the default deployment is not a mode.
 *
 *  Between them sits the reason the routes are UNMOUNTED rather than guarded,
 *  which is the one property tests cannot really assert: a handler that is not
 *  reachable cannot be reached by somebody forgetting a check.
 */

const userFindUnique = vi.hoisted(() => vi.fn());
const userCreate = vi.hoisted(() => vi.fn());
const userUpdate = vi.hoisted(() => vi.fn());

const planFindUnique = vi.hoisted(() => vi.fn());

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    user: {
      findUnique: userFindUnique,
      create: userCreate,
      update: userUpdate,
    },
    plan: { findUnique: planFindUnique },
  },
}));

const info = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
const error = vi.hoisted(() => vi.fn());
vi.mock("../lib/logger.js", () => ({
  logger: { info, warn, error, debug: vi.fn() },
}));

vi.mock("argon2", () => ({
  default: { hash: vi.fn(() => Promise.resolve("hashed")), argon2id: 2 },
}));

const EMAIL = "me@example.com";

/** The module reads `env` once at import, so each configuration needs its own
 *  import of it. */
async function loadWith(
  vars: { email?: string; password?: string } = {},
) {
  vi.resetModules();
  process.env["SINGLE_USER_EMAIL"] = vars.email ?? "";
  process.env["SINGLE_USER_PASSWORD"] = vars.password ?? "";
  return import("./singleUserService.js");
}

beforeEach(() => {
  vi.clearAllMocks();
  userFindUnique.mockResolvedValue(null);
  planFindUnique.mockResolvedValue({ id: "personal" });
  userCreate.mockResolvedValue({ id: "u1", email: EMAIL });
  userUpdate.mockResolvedValue({ id: "u1", email: EMAIL });
});

describe("when it is not configured", () => {
  it("is off", async () => {
    const { singleUserEnabled, singleUserEmail } = await loadWith();

    expect(singleUserEnabled()).toBe(false);
    expect(singleUserEmail()).toBeNull();
  });

  it("provisions nothing", async () => {
    const { ensureSingleUser } = await loadWith();

    await ensureSingleUser();

    // A mode that creates an account on an ordinary deployment is not a mode.
    expect(userCreate).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("lets accounts be created, exactly as before", async () => {
    const { assertCanCreateAccount } = await loadWith();

    expect(() => assertCanCreateAccount()).not.toThrow();
  });
});

describe("provisioning the account", () => {
  it("creates it with the configured password, already verified", async () => {
    const { ensureSingleUser } = await loadWith({
      email: EMAIL,
      password: "hunter22",
    });

    await ensureSingleUser();

    expect(userCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: EMAIL,
        passwordHash: "hashed",
        // Nothing to verify: the operator wrote this address into their own
        // server's configuration, and there is no verification route mounted
        // to confirm it with anyway.
        emailVerifiedAt: expect.any(Date),
      }),
    });
  });

  it("rewrites the password on a later boot, which is the whole recovery story", async () => {
    userFindUnique.mockResolvedValue({
      id: "u1",
      email: EMAIL,
      emailVerifiedAt: new Date(),
    });

    const { ensureSingleUser } = await loadWith({
      email: EMAIL,
      password: "a-new-one",
    });

    await ensureSingleUser();

    // There is no reset route in this mode. Editing the environment and
    // restarting is what replaces it, and that only works if boot actually
    // overwrites rather than skipping an account that already exists.
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ passwordHash: "hashed" }),
      }),
    );
  });

  it("leaves the password alone when none is configured", async () => {
    userFindUnique.mockResolvedValue({
      id: "u1",
      email: EMAIL,
      emailVerifiedAt: new Date(),
      // Already on the right plan, so the only thing that could write here is
      // the password -- which is exactly what this asserts does not happen.
      planId: "personal",
    });

    const { ensureSingleUser } = await loadWith({ email: EMAIL });

    await ensureSingleUser();

    // So the variable can be removed from the environment once it has been
    // used, rather than living there for the life of the deployment.
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("generates one on a first boot with none set, and says so once", async () => {
    const { ensureSingleUser } = await loadWith({ email: EMAIL });

    await ensureSingleUser();

    expect(userCreate).toHaveBeenCalled();
    // An account that exists and cannot be signed in to is worse than a
    // password in a log file on a machine whose owner is the only user.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("generated password"),
      expect.objectContaining({ password: expect.any(String) }),
    );
  });

  it("verifies an existing account that was never confirmed", async () => {
    userFindUnique.mockResolvedValue({
      id: "u1",
      email: EMAIL,
      emailVerifiedAt: null,
    });

    const { ensureSingleUser } = await loadWith({
      email: EMAIL,
      password: "hunter22",
    });

    await ensureSingleUser();

    // An account that predates the mode could be unverified, and there is no
    // route mounted that could ever confirm it.
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ emailVerifiedAt: expect.any(Date) }),
      }),
    );
  });

  it("reports a database it cannot reach rather than taking the process down", async () => {
    userFindUnique.mockRejectedValue(new Error("ECONNREFUSED"));

    const { ensureSingleUser } = await loadWith({ email: EMAIL });

    // The likeliest cause is Postgres not being up yet, and a crash loop is a
    // worse answer to that than a log line and the next boot.
    await expect(ensureSingleUser()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});

describe("the creation boundary", () => {
  it("refuses a second account", async () => {
    const { assertCanCreateAccount } = await loadWith({ email: EMAIL });

    expect(() => assertCanCreateAccount()).toThrowError(
      /single account/i,
    );
  });

  it("refuses even the configured address", async () => {
    const { assertCanCreateAccount } = await loadWith({ email: EMAIL });

    // Deliberately. That account is provisioned at boot, so a request reaching
    // here is either a second account or a race with the boot that made the
    // first -- and "the email matches, let it through" would be a second way to
    // create the one account, with different rules from the first.
    expect(() => assertCanCreateAccount()).toThrow();
  });
});

describe("the plan the account lands on", () => {
  it("is the personal one, whose allocations are unlimited", async () => {
    const { ensureSingleUser } = await loadWith({
      email: EMAIL,
      password: "hunter22",
    });

    await ensureSingleUser();

    // §10.4's half. Every per-account limit rations a shared VM between
    // tenants, and there is nobody here to ration against.
    expect(userCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ planId: "personal" }),
    });
  });

  it("moves an account that predates the mode onto it", async () => {
    userFindUnique.mockResolvedValue({
      id: "u1",
      email: EMAIL,
      emailVerifiedAt: new Date(),
      planId: "free",
    });

    // No password configured, so this is the branch that would otherwise do
    // nothing at all -- and doing nothing would leave somebody meeting a
    // twenty-project limit on their own machine with no way to see why.
    const { ensureSingleUser } = await loadWith({ email: EMAIL });

    await ensureSingleUser();

    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { planId: "personal" },
    });
  });

  it("does not rewrite the plan when it is already right", async () => {
    userFindUnique.mockResolvedValue({
      id: "u1",
      email: EMAIL,
      emailVerifiedAt: new Date(),
      planId: "personal",
    });

    const { ensureSingleUser } = await loadWith({ email: EMAIL });

    await ensureSingleUser();

    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("still provisions the account when the plan row is missing", async () => {
    planFindUnique.mockResolvedValue(null);

    const { ensureSingleUser } = await loadWith({
      email: EMAIL,
      password: "hunter22",
    });

    await ensureSingleUser();

    // A deployment whose migrations have not caught up should get its account
    // on whatever plan it has, rather than no account at all. The same
    // fail-toward-something reasoning `resolveEntitlements` uses.
    expect(userCreate).toHaveBeenCalled();
    expect(userCreate.mock.calls[0]?.[0]?.data).not.toHaveProperty("planId");
  });
});
