import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Signing in when the account has a second factor. plan.md §11.6.
 *
 *  The property worth protecting is one sentence long: **a correct password
 *  alone must not produce anything usable.** Everything below is a way that
 *  could stop being true — a cookie written before the code step, a challenge
 *  that works as a bearer token, a second step that takes the account from the
 *  request body instead of from the signed challenge.
 */

const authService = vi.hoisted(() => ({
  authenticateUser: vi.fn(),
  getUserById: vi.fn(),
  registerUser: vi.fn(),
}));
const refreshTokenService = vi.hoisted(() => ({
  issueRefreshToken: vi.fn(),
  revokeRefreshToken: vi.fn(),
  rotateRefreshToken: vi.fn(),
  revokeAllForUser: vi.fn(),
}));
const twoFactorService = vi.hoisted(() => ({
  requiresSecondFactor: vi.fn(),
  consumeSecondFactor: vi.fn(),
}));

vi.mock("../service/authService.js", () => authService);
vi.mock("../service/refreshTokenService.js", () => refreshTokenService);
vi.mock("../service/twoFactorService.js", () => twoFactorService);
vi.mock("../service/userTokenService.js", () => ({
  consumeUserToken: vi.fn(),
  issueUserToken: vi.fn(),
  UserTokenPurpose: {},
}));
vi.mock("../lib/prisma.js", () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
}));
vi.mock("../lib/mailer.js", () => ({
  getMailer: () => ({ send: vi.fn() }),
  hasRealMailer: () => false,
  webUrl: () => "https://web.example",
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
}));

import express from "express";
import { login, loginTotp, me } from "./authController.js";
import { asyncHandler, errorHandler } from "../middlewares/errorHandler.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { signMfaToken } from "../service/tokenService.js";

const USER = { id: "u1", email: "someone@example.com", isAdmin: false };

const app = express();
app.use(express.json());
app.post("/login", asyncHandler(login));
app.post("/login/totp", asyncHandler(loginTotp));
// Mounted so the challenge token can be presented as a bearer credential and
// refused by the real middleware rather than by an assertion about it.
app.get("/me", requireAuth, asyncHandler(me));
app.use(errorHandler);

const CREDENTIALS = { email: "someone@example.com", password: "hunter2hunter2" };

beforeEach(() => {
  vi.clearAllMocks();
  authService.authenticateUser.mockResolvedValue(USER);
  authService.getUserById.mockResolvedValue(USER);
  refreshTokenService.issueRefreshToken.mockResolvedValue({ token: "refresh" });
  twoFactorService.requiresSecondFactor.mockResolvedValue(false);
  twoFactorService.consumeSecondFactor.mockResolvedValue("totp");
});

describe("an account with no second factor", () => {
  it("signs in in one step, as it always did", async () => {
    const response = await request(app).post("/login").send(CREDENTIALS);

    expect(response.status).toBe(200);
    expect(response.body.data.accessToken).toBeTruthy();
    expect(response.headers["set-cookie"]).toBeTruthy();
  });
});

describe("an account with one", () => {
  beforeEach(() => {
    twoFactorService.requiresSecondFactor.mockResolvedValue(true);
  });

  /** The whole point. A right password gets a challenge, not a session. */
  it("answers with a challenge rather than a session", async () => {
    const response = await request(app).post("/login").send(CREDENTIALS);

    expect(response.status).toBe(200);
    expect(response.body.data.mfaRequired).toBe(true);
    expect(response.body.data.mfaToken).toBeTruthy();
    expect(response.body.data.accessToken).toBeUndefined();
    expect(response.body.data.user).toBeUndefined();
  });

  /** A client that ignores `mfaRequired` and carries on must get nothing it
   *  can use. Cookies are the half a caller cannot choose to ignore, so they
   *  are the half worth asserting. */
  it("writes no cookies at the password step", async () => {
    const response = await request(app).post("/login").send(CREDENTIALS);

    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(refreshTokenService.issueRefreshToken).not.toHaveBeenCalled();
  });

  /** The mistake the `typ` claim exists to prevent, checked against the real
   *  middleware rather than asserted about. */
  it("will not let the challenge be used as a bearer token", async () => {
    const { body } = await request(app).post("/login").send(CREDENTIALS);

    const response = await request(app)
      .get("/me")
      .set("Authorization", `Bearer ${body.data.mfaToken as string}`);

    expect(response.status).toBe(401);
  });

  it("issues the session once the code is right", async () => {
    const { body } = await request(app).post("/login").send(CREDENTIALS);

    const response = await request(app)
      .post("/login/totp")
      .send({ mfaToken: body.data.mfaToken, code: "123456" });

    expect(response.status).toBe(200);
    expect(response.body.data.accessToken).toBeTruthy();
    expect(response.headers["set-cookie"]).toBeTruthy();
    expect(twoFactorService.consumeSecondFactor).toHaveBeenCalledWith(
      "u1",
      "123456",
    );
  });

  /** Said out loud, because a recovery code is a thing you have one fewer of
   *  and nothing else would ever mention it. */
  it("says when a recovery code was what got you in", async () => {
    twoFactorService.consumeSecondFactor.mockResolvedValue("recovery");
    const { body } = await request(app).post("/login").send(CREDENTIALS);

    const response = await request(app)
      .post("/login/totp")
      .send({ mfaToken: body.data.mfaToken, code: "abcd-efgh" });

    expect(response.body.message).toMatch(/recovery code/);
  });

  it("issues nothing when the code is wrong", async () => {
    const { UnauthorizedError } = await import("../utils/errors.js");
    twoFactorService.consumeSecondFactor.mockRejectedValue(
      new UnauthorizedError("That code is not right."),
    );
    const { body } = await request(app).post("/login").send(CREDENTIALS);

    const response = await request(app)
      .post("/login/totp")
      .send({ mfaToken: body.data.mfaToken, code: "000000" });

    expect(response.status).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(refreshTokenService.issueRefreshToken).not.toHaveBeenCalled();
  });

  /** The account is named by the SIGNED challenge and never by the request, or
   *  this would be an endpoint that trades a code for a session on anybody's
   *  account. */
  it("ignores any account named in the body", async () => {
    const { body } = await request(app).post("/login").send(CREDENTIALS);

    await request(app).post("/login/totp").send({
      mfaToken: body.data.mfaToken,
      code: "123456",
      userId: "somebody-else",
      email: "victim@example.com",
    });

    expect(twoFactorService.consumeSecondFactor).toHaveBeenCalledWith(
      "u1",
      "123456",
    );
  });

  it("refuses a challenge it did not sign", async () => {
    const response = await request(app)
      .post("/login/totp")
      .send({ mfaToken: "not.a.token", code: "123456" });

    expect(response.status).toBe(401);
    expect(twoFactorService.consumeSecondFactor).not.toHaveBeenCalled();
  });

  /** A challenge for an account deleted between the two steps must not become
   *  a session. */
  it("refuses when the account has gone in between", async () => {
    authService.getUserById.mockResolvedValue(null);
    const { body } = await request(app).post("/login").send(CREDENTIALS);

    const response = await request(app)
      .post("/login/totp")
      .send({ mfaToken: body.data.mfaToken, code: "123456" });

    expect(response.status).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
});

describe("the challenge itself", () => {
  /** Signed for one account, and carrying nothing else. */
  it("names the account it was minted for", async () => {
    const { verifyMfaToken } = await import("../service/tokenService.js");

    expect(verifyMfaToken(signMfaToken("u9")).sub).toBe("u9");
  });
});
