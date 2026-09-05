import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Turning a second factor on and off.
 *
 *  One guard carries this whole file: the two operations that make an account
 *  WEAKER — disabling, and minting a fresh set of recovery codes — ask for the
 *  password again. Without it a session somebody else is holding (a laptop
 *  left open, a stolen access token) can switch the protection off and keep
 *  the account, which makes the second factor decoration.
 */

const service = vi.hoisted(() => ({
  beginEnrolment: vi.fn(),
  confirmEnrolment: vi.fn(),
  disableTwoFactor: vi.fn(),
  getTwoFactorStatus: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
}));
vi.mock("../service/twoFactorService.js", () => service);

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("../lib/prisma.js", () => ({ prisma: { user: { findUnique } } }));

const verify = vi.hoisted(() => vi.fn());
vi.mock("argon2", () => ({ default: { verify } }));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
}));

import {
  beginTwoFactorController,
  confirmTwoFactorController,
  disableTwoFactorController,
  regenerateRecoveryCodesController,
  twoFactorStatusController,
} from "./twoFactorController.js";
import { apiApp, bearer } from "../test/apiHarness.js";

const app = apiApp([
  { method: "get", path: "/2fa", handler: twoFactorStatusController },
  { method: "post", path: "/2fa/begin", handler: beginTwoFactorController },
  { method: "post", path: "/2fa/confirm", handler: confirmTwoFactorController },
  { method: "post", path: "/2fa/disable", handler: disableTwoFactorController },
  {
    method: "post",
    path: "/2fa/recovery-codes",
    handler: regenerateRecoveryCodesController,
  },
]);

const STATUS = { enabled: true, pending: false, recoveryCodesLeft: 10 };

function post(path: string, body: Record<string, unknown> = {}) {
  return request(app).post(path).set("Authorization", bearer()).send(body);
}

beforeEach(() => {
  vi.clearAllMocks();
  service.getTwoFactorStatus.mockResolvedValue(STATUS);
  service.beginEnrolment.mockResolvedValue({
    secret: "ABCD",
    otpauthUrl: "otpauth://totp/x",
  });
  service.confirmEnrolment.mockResolvedValue(["abcd-efgh"]);
  service.regenerateRecoveryCodes.mockResolvedValue(["abcd-efgh"]);
  service.disableTwoFactor.mockResolvedValue(undefined);
  findUnique.mockResolvedValue({ passwordHash: "argon2-hash" });
  verify.mockResolvedValue(true);
});

describe("reading and enrolling", () => {
  it("reports the status", async () => {
    const response = await request(app)
      .get("/2fa")
      .set("Authorization", bearer());

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(STATUS);
  });

  /** No password to start: enrolling ADDS protection, and asking for it again
   *  would be friction with nothing on the other side of it. */
  it("starts enrolment without asking for the password again", async () => {
    const response = await post("/2fa/begin");

    expect(response.status).toBe(200);
    expect(response.body.data.otpauthUrl).toBe("otpauth://totp/x");
    expect(verify).not.toHaveBeenCalled();
  });

  it("enrols the account the SESSION names, not the body", async () => {
    await post("/2fa/begin", { userId: "somebody-else" });

    expect(service.beginEnrolment).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
    );
    expect(service.beginEnrolment.mock.calls[0]?.[0]).not.toBe("somebody-else");
  });

  it("returns the recovery codes when enrolment is confirmed", async () => {
    const response = await post("/2fa/confirm", { code: "123456" });

    expect(response.status).toBe(200);
    expect(response.body.data.recoveryCodes).toEqual(["abcd-efgh"]);
  });

  it("refuses a confirm with no code", async () => {
    expect((await post("/2fa/confirm", {})).status).toBe(400);
    expect(service.confirmEnrolment).not.toHaveBeenCalled();
  });
});

describe("the password re-check", () => {
  /** The one that makes the whole feature worth having. */
  it("will not disable on a wrong password", async () => {
    verify.mockResolvedValue(false);

    const response = await post("/2fa/disable", { password: "guess" });

    expect(response.status).toBe(401);
    expect(service.disableTwoFactor).not.toHaveBeenCalled();
  });

  it("disables when the password is right", async () => {
    const response = await post("/2fa/disable", { password: "hunter2" });

    expect(response.status).toBe(200);
    expect(service.disableTwoFactor).toHaveBeenCalled();
  });

  /** Ten permanent bypasses is worse than turning it off, because nothing
   *  would look wrong afterwards. */
  it("will not mint new recovery codes on a wrong password", async () => {
    verify.mockResolvedValue(false);

    const response = await post("/2fa/recovery-codes", { password: "guess" });

    expect(response.status).toBe(401);
    expect(service.regenerateRecoveryCodes).not.toHaveBeenCalled();
  });

  it("mints them when the password is right", async () => {
    const response = await post("/2fa/recovery-codes", { password: "hunter2" });

    expect(response.status).toBe(200);
    expect(response.body.data.recoveryCodes).toEqual(["abcd-efgh"]);
  });

  /** An account created through GitHub sign-in has no password. "There is
   *  nothing to check" is not the same as "the check passed", so it is refused
   *  rather than waved through. */
  it("refuses an account with no password rather than skipping the check", async () => {
    findUnique.mockResolvedValue({ passwordHash: null });

    const response = await post("/2fa/disable", { password: "anything" });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("NO_PASSWORD");
    expect(service.disableTwoFactor).not.toHaveBeenCalled();
  });

  /** argon2 throws on a malformed hash rather than returning false, and an
   *  unhandled throw here would be a 500 — which is a different thing from a
   *  refusal and would read as a server fault. */
  it("treats a verifier that throws as a refusal", async () => {
    verify.mockRejectedValue(new Error("bad hash"));

    const response = await post("/2fa/disable", { password: "hunter2" });

    expect(response.status).toBe(401);
    expect(service.disableTwoFactor).not.toHaveBeenCalled();
  });

  it("refuses a disable with no password at all", async () => {
    expect((await post("/2fa/disable", {})).status).toBe(400);
    expect(service.disableTwoFactor).not.toHaveBeenCalled();
  });
});
