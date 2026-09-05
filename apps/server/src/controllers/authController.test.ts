import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const userTokenService = vi.hoisted(() => ({
  consumeUserToken: vi.fn(),
  issueUserToken: vi.fn(),
  UserTokenPurpose: {
    PASSWORD_RESET: "PASSWORD_RESET",
    EMAIL_VERIFICATION: "EMAIL_VERIFICATION",
  },
}));

const prismaUser = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn() }));
const send = vi.hoisted(() => vi.fn());
const hasRealMailer = vi.hoisted(() => vi.fn(() => false));

/** A second factor, which `login` now asks about on every sign-in (plan.md
 *  §11.6). False here, because every assertion in this file is about the
 *  ordinary one-step sign-in; `twoFactorLogin.test.ts` covers the other. */
const twoFactorService = vi.hoisted(() => ({
  requiresSecondFactor: vi.fn(() => Promise.resolve(false)),
  consumeSecondFactor: vi.fn(),
}));
vi.mock("../service/twoFactorService.js", () => twoFactorService);

vi.mock("../service/authService.js", () => authService);
vi.mock("../service/refreshTokenService.js", () => refreshTokenService);
vi.mock("../service/userTokenService.js", () => userTokenService);
vi.mock("../lib/prisma.js", () => ({ prisma: { user: prismaUser } }));
vi.mock("../lib/mailer.js", () => ({
  getMailer: () => ({ send }),
  hasRealMailer,
  webUrl: (path: string, query: Record<string, string>) =>
    `https://web.example/${path}?token=${query["token"] ?? ""}`,
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
}));
vi.mock("argon2", () => ({
  default: { hash: vi.fn().mockResolvedValue("argon2-hash"), argon2id: 2 },
}));

import {
  login,
  logout,
  me,
  refresh,
  requestEmailVerification,
  requestPasswordReset,
  resetPassword,
  signup,
  verifyEmail,
} from "./authController.js";
import { apiApp, bearer, TEST_USER } from "../test/apiHarness.js";
import {
  PREVIEW_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  verifyAccessToken,
  verifyPreviewToken,
} from "../service/tokenService.js";
import { UnauthorizedError } from "../utils/errors.js";

const publicApp = apiApp(
  [
    { method: "post", path: "/auth/signup", handler: signup },
    { method: "post", path: "/auth/login", handler: login },
    { method: "post", path: "/auth/refresh", handler: refresh },
    { method: "post", path: "/auth/logout", handler: logout },
    { method: "post", path: "/auth/password-reset", handler: requestPasswordReset },
    { method: "post", path: "/auth/password-reset/confirm", handler: resetPassword },
    { method: "post", path: "/auth/verify-email", handler: verifyEmail },
  ],
  { auth: false },
);

const authedApp = apiApp([
  { method: "get", path: "/auth/me", handler: me },
  {
    method: "post",
    path: "/auth/verify-email/request",
    handler: requestEmailVerification,
  },
]);

const USER = { id: TEST_USER.sub, email: TEST_USER.email };
const REFRESH_TOKEN = "opaque-refresh-token";

/** The Set-Cookie header, split into one entry per cookie name. */
function cookies(response: request.Response): Record<string, string> {
  const raw = response.headers["set-cookie"] as unknown as string[] | undefined;
  const found: Record<string, string> = {};

  for (const entry of raw ?? []) {
    const name = entry.slice(0, entry.indexOf("="));
    found[name] = entry;
  }

  return found;
}

function cookieValue(entry: string): string {
  return decodeURIComponent(entry.slice(entry.indexOf("=") + 1, entry.indexOf(";")));
}

beforeEach(() => {
  vi.clearAllMocks();
  hasRealMailer.mockReturnValue(false);
  refreshTokenService.issueRefreshToken.mockResolvedValue({ token: REFRESH_TOKEN });
});

describe.each([
  ["signup", "/auth/signup", authService.registerUser],
  ["login", "/auth/login", authService.authenticateUser],
])("%s", (_name, path, service) => {
  it("returns an access token for the new session", async () => {
    service.mockResolvedValue(USER);

    const response = await request(publicApp)
      .post(path)
      .send({ email: TEST_USER.email, password: "correct horse battery" });

    expect(response.status).toBe(200);
    expect(response.body.data.user).toEqual(USER);
    // A real, verifiable token rather than any old string.
    expect(verifyAccessToken(response.body.data.accessToken)).toEqual({
      sub: USER.id,
      email: USER.email,
    });
  });

  it("sets the refresh cookie httpOnly and scoped to the auth routes", async () => {
    service.mockResolvedValue(USER);

    const response = await request(publicApp)
      .post(path)
      .send({ email: TEST_USER.email, password: "correct horse battery" });

    const cookie = cookies(response)[REFRESH_COOKIE_NAME];
    expect(cookie).toBeDefined();
    expect(cookieValue(cookie!)).toBe(REFRESH_TOKEN);
    // httpOnly is what keeps it out of reach of anything running in the page.
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/i);
  });

  /** Scoped to /preview so it travels with the iframe and its HMR socket and
   *  with nothing else — it is handed to code the platform treats as
   *  untrusted. */
  it("sets a preview cookie scoped to /preview, and it is only a preview token", async () => {
    service.mockResolvedValue(USER);

    const response = await request(publicApp)
      .post(path)
      .send({ email: TEST_USER.email, password: "correct horse battery" });

    const cookie = cookies(response)[PREVIEW_COOKIE_NAME];
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/preview/i);

    const token = cookieValue(cookie!);
    expect(verifyPreviewToken(token)).toEqual({ sub: USER.id });
    // Signed with the access secret, so only its type stops it working as one.
    expect(() => verifyAccessToken(token)).toThrow(UnauthorizedError);
  });

  it.each([
    ["no body", {}],
    ["an invalid email", { email: "nope", password: "correct horse battery" }],
    ["a short password", { email: "a@b.com", password: "short" }],
    ["a missing password", { email: "a@b.com" }],
  ])("rejects %s with a 400", async (_label, body) => {
    const response = await request(publicApp).post(path).send(body);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
    expect(service).not.toHaveBeenCalled();
  });

  it("issues a refresh token for the account it just resolved", async () => {
    service.mockResolvedValue(USER);

    await request(publicApp)
      .post(path)
      .send({ email: TEST_USER.email, password: "correct horse battery" });

    expect(refreshTokenService.issueRefreshToken).toHaveBeenCalledWith(USER.id);
  });
});

describe("login", () => {
  it("relays a 401 without saying which half was wrong", async () => {
    authService.authenticateUser.mockRejectedValue(
      new UnauthorizedError("Email or password is incorrect"),
    );

    const response = await request(publicApp)
      .post("/auth/login")
      .send({ email: TEST_USER.email, password: "wrong password here" });

    expect(response.status).toBe(401);
    expect(response.body.message).not.toMatch(/no such account|unknown email/i);
    expect(cookies(response)[REFRESH_COOKIE_NAME]).toBeUndefined();
  });
});

describe("refresh", () => {
  it("rotates the presented token and returns a new access token", async () => {
    refreshTokenService.rotateRefreshToken.mockResolvedValue({
      userId: USER.id,
      token: "rotated-token",
    });
    authService.getUserById.mockResolvedValue(USER);

    const response = await request(publicApp)
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE_NAME}=${REFRESH_TOKEN}`);

    expect(response.status).toBe(200);
    expect(refreshTokenService.rotateRefreshToken).toHaveBeenCalledWith(REFRESH_TOKEN);
    expect(cookieValue(cookies(response)[REFRESH_COOKIE_NAME]!)).toBe("rotated-token");
    expect(verifyAccessToken(response.body.data.accessToken).sub).toBe(USER.id);
  });

  it("reissues the preview cookie too, so it never outlives the session", async () => {
    refreshTokenService.rotateRefreshToken.mockResolvedValue({
      userId: USER.id,
      token: "rotated-token",
    });
    authService.getUserById.mockResolvedValue(USER);

    const response = await request(publicApp)
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE_NAME}=${REFRESH_TOKEN}`);

    expect(cookies(response)[PREVIEW_COOKIE_NAME]).toBeDefined();
  });

  it("refuses when no refresh cookie was sent", async () => {
    const response = await request(publicApp).post("/auth/refresh");

    expect(response.status).toBe(401);
    expect(refreshTokenService.rotateRefreshToken).not.toHaveBeenCalled();
  });

  /** Rotation is single-use: presenting a spent token revokes the whole family,
   *  and the caller must be told the session is gone rather than retried. */
  it("relays a revoked-family refusal as a 401", async () => {
    refreshTokenService.rotateRefreshToken.mockRejectedValue(
      new UnauthorizedError("Session was reused and has been revoked"),
    );

    const response = await request(publicApp)
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE_NAME}=${REFRESH_TOKEN}`);

    expect(response.status).toBe(401);
    expect(response.body.message).toMatch(/reused/i);
  });

  it("refuses when the account has since been deleted", async () => {
    refreshTokenService.rotateRefreshToken.mockResolvedValue({
      userId: USER.id,
      token: "rotated-token",
    });
    authService.getUserById.mockResolvedValue(null);

    const response = await request(publicApp)
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE_NAME}=${REFRESH_TOKEN}`);

    expect(response.status).toBe(401);
  });
});

describe("logout", () => {
  /** Clearing the cookie alone left the token itself working for anyone who had
   *  captured it — the server-side record is the point. */
  it("revokes the presented token server-side", async () => {
    refreshTokenService.revokeRefreshToken.mockResolvedValue(undefined);

    const response = await request(publicApp)
      .post("/auth/logout")
      .set("Cookie", `${REFRESH_COOKIE_NAME}=${REFRESH_TOKEN}`);

    expect(response.status).toBe(200);
    expect(refreshTokenService.revokeRefreshToken).toHaveBeenCalledWith(REFRESH_TOKEN);
  });

  it("clears both session cookies", async () => {
    const response = await request(publicApp)
      .post("/auth/logout")
      .set("Cookie", `${REFRESH_COOKIE_NAME}=${REFRESH_TOKEN}`);

    const cleared = cookies(response);
    expect(cookieValue(cleared[REFRESH_COOKIE_NAME]!)).toBe("");
    expect(cookieValue(cleared[PREVIEW_COOKIE_NAME]!)).toBe("");
  });

  it("succeeds when there was no session to end", async () => {
    const response = await request(publicApp).post("/auth/logout");

    expect(response.status).toBe(200);
    expect(refreshTokenService.revokeRefreshToken).not.toHaveBeenCalled();
  });
});

describe("me", () => {
  it("returns the signed-in user", async () => {
    authService.getUserById.mockResolvedValue(USER);

    const response = await request(authedApp).get("/auth/me").set("Authorization", bearer());

    expect(response.status).toBe(200);
    expect(response.body.data.user).toEqual(USER);
    expect(authService.getUserById).toHaveBeenCalledWith(TEST_USER.sub);
  });

  it("refuses without a bearer token", async () => {
    const response = await request(authedApp).get("/auth/me");

    expect(response.status).toBe(401);
    expect(authService.getUserById).not.toHaveBeenCalled();
  });

  it("refuses when the account has been deleted since the token was issued", async () => {
    authService.getUserById.mockResolvedValue(null);

    const response = await request(authedApp).get("/auth/me").set("Authorization", bearer());

    expect(response.status).toBe(401);
  });
});

describe("requestPasswordReset", () => {
  /** Saying "no account with that email" turns this into a way to discover who
   *  has an account here, which is exactly what an attacker wants before trying
   *  passwords. Every branch below must be indistinguishable from outside. */
  it("answers identically whether or not the account exists", async () => {
    prismaUser.findUnique.mockResolvedValue({
      id: USER.id,
      email: USER.email,
      passwordHash: "hash",
    });
    userTokenService.issueUserToken.mockResolvedValue("reset-token");

    const existing = await request(publicApp)
      .post("/auth/password-reset")
      .send({ email: USER.email });

    prismaUser.findUnique.mockResolvedValue(null);
    const missing = await request(publicApp)
      .post("/auth/password-reset")
      .send({ email: "nobody@example.com" });

    expect(existing.status).toBe(missing.status);
    expect(existing.body).toEqual(missing.body);
  });

  it("mails a reset link to an account that has a password", async () => {
    prismaUser.findUnique.mockResolvedValue({
      id: USER.id,
      email: USER.email,
      passwordHash: "hash",
    });
    userTokenService.issueUserToken.mockResolvedValue("reset-token");

    await request(publicApp).post("/auth/password-reset").send({ email: USER.email });

    expect(userTokenService.issueUserToken).toHaveBeenCalledWith(
      USER.id,
      "PASSWORD_RESET",
    );
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].text).toContain("reset-token");
  });

  /** Telling them to sign in the way they signed up is more useful than a link
   *  that cannot help. */
  it("tells a GitHub account there is no password to reset", async () => {
    prismaUser.findUnique.mockResolvedValue({
      id: USER.id,
      email: USER.email,
      passwordHash: null,
    });

    await request(publicApp).post("/auth/password-reset").send({ email: USER.email });

    expect(userTokenService.issueUserToken).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0].text).toMatch(/GitHub/);
  });

  it("sends nothing at all when there is no such account", async () => {
    prismaUser.findUnique.mockResolvedValue(null);

    await request(publicApp)
      .post("/auth/password-reset")
      .send({ email: "nobody@example.com" });

    expect(send).not.toHaveBeenCalled();
  });

  it("reports whether a link was really delivered", async () => {
    prismaUser.findUnique.mockResolvedValue(null);
    hasRealMailer.mockReturnValue(true);

    const response = await request(publicApp)
      .post("/auth/password-reset")
      .send({ email: "a@b.com" });

    expect(response.body.data).toEqual({ delivered: true });
  });

  it("rejects an invalid email", async () => {
    const response = await request(publicApp)
      .post("/auth/password-reset")
      .send({ email: "not-an-email" });

    expect(response.status).toBe(400);
    expect(prismaUser.findUnique).not.toHaveBeenCalled();
  });
});

describe("resetPassword", () => {
  it("spends the token, rewrites the hash, and ends every existing session", async () => {
    userTokenService.consumeUserToken.mockResolvedValue(USER.id);
    prismaUser.update.mockResolvedValue(USER);

    const response = await request(publicApp)
      .post("/auth/password-reset/confirm")
      .send({ token: "reset-token", password: "a brand new password" });

    expect(response.status).toBe(200);
    expect(userTokenService.consumeUserToken).toHaveBeenCalledWith(
      "reset-token",
      "PASSWORD_RESET",
    );
    expect(prismaUser.update).toHaveBeenCalledWith({
      where: { id: USER.id },
      data: { passwordHash: "argon2-hash" },
    });
    // Whoever prompted the reset may be holding a live session.
    expect(refreshTokenService.revokeAllForUser).toHaveBeenCalledWith(USER.id);
  });

  it.each([
    ["no token", { password: "a brand new password" }],
    ["an empty token", { token: "", password: "a brand new password" }],
    ["a short password", { token: "t", password: "short" }],
    ["no password", { token: "t" }],
  ])("rejects %s", async (_label, body) => {
    const response = await request(publicApp)
      .post("/auth/password-reset/confirm")
      .send(body);

    expect(response.status).toBe(400);
    expect(prismaUser.update).not.toHaveBeenCalled();
  });

  it("does not touch the password when the token is spent or unknown", async () => {
    userTokenService.consumeUserToken.mockRejectedValue(
      new UnauthorizedError("That link has expired"),
    );

    const response = await request(publicApp)
      .post("/auth/password-reset/confirm")
      .send({ token: "stale", password: "a brand new password" });

    expect(response.status).toBe(401);
    expect(prismaUser.update).not.toHaveBeenCalled();
    expect(refreshTokenService.revokeAllForUser).not.toHaveBeenCalled();
  });
});

describe("email verification", () => {
  it("mails a fresh link to the signed-in user", async () => {
    authService.getUserById.mockResolvedValue(USER);
    userTokenService.issueUserToken.mockResolvedValue("verify-token");

    const response = await request(authedApp)
      .post("/auth/verify-email/request")
      .set("Authorization", bearer());

    expect(response.status).toBe(200);
    expect(userTokenService.issueUserToken).toHaveBeenCalledWith(
      TEST_USER.sub,
      "EMAIL_VERIFICATION",
    );
    expect(send.mock.calls[0]?.[0].to).toBe(USER.email);
  });

  it("will not send a verification link to an anonymous caller", async () => {
    const response = await request(authedApp).post("/auth/verify-email/request");

    expect(response.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("stamps the account as verified when the token is spent", async () => {
    userTokenService.consumeUserToken.mockResolvedValue(USER.id);
    prismaUser.update.mockResolvedValue(USER);

    const response = await request(publicApp)
      .post("/auth/verify-email")
      .send({ token: "verify-token" });

    expect(response.status).toBe(200);
    expect(userTokenService.consumeUserToken).toHaveBeenCalledWith(
      "verify-token",
      "EMAIL_VERIFICATION",
    );
    expect(prismaUser.update.mock.calls[0]?.[0].data.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it.each([[{}], [{ token: "" }], [{ token: 7 }]])(
    "rejects a verify-email body of %o",
    async (body) => {
      const response = await request(publicApp).post("/auth/verify-email").send(body);

      expect(response.status).toBe(400);
      expect(prismaUser.update).not.toHaveBeenCalled();
    },
  );

  /** A verification token is not a password-reset token, even though both are
   *  opaque strings issued by the same service. */
  it("will not accept a token issued for a different purpose", async () => {
    userTokenService.consumeUserToken.mockRejectedValue(
      new UnauthorizedError("That link is not valid"),
    );

    const response = await request(publicApp)
      .post("/auth/verify-email")
      .send({ token: "a-password-reset-token" });

    expect(response.status).toBe(401);
    expect(prismaUser.update).not.toHaveBeenCalled();
  });
});
