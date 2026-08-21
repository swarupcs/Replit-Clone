import express from "express";
import type { Request, Response } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { getAuthContext, requireAuth } from "./requireAuth.js";
import {
  signAccessToken,
  signPreviewToken,
  signRefreshToken,
} from "../service/tokenService.js";
import { errorHandler } from "./errorHandler.js";
import { UnauthorizedError } from "../utils/errors.js";

const USER = { sub: "11111111-1111-4111-8111-111111111111", email: "a@example.com" };

/** A minimal app that reports whichever context requireAuth established. */
function app() {
  const instance = express();

  instance.get("/guarded", requireAuth, (req: Request, res: Response) => {
    res.json(getAuthContext(req));
  });

  instance.use(errorHandler);
  return instance;
}

describe("requireAuth", () => {
  it("admits a valid access token and exposes its claims", async () => {
    const response = await request(app())
      .get("/guarded")
      .set("Authorization", `Bearer ${signAccessToken(USER)}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: USER.sub, email: USER.email });
  });

  it("rejects a request with no Authorization header", async () => {
    const response = await request(app()).get("/guarded");

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      success: false,
      code: "UNAUTHORIZED",
      message: "Missing bearer token",
    });
  });

  it.each([
    ["a non-bearer scheme", "Basic dXNlcjpwYXNz"],
    ["a bare token with no scheme", signAccessToken(USER)],
    ["a lowercase scheme", `bearer ${signAccessToken(USER)}`],
  ])("rejects %s", async (_label, header) => {
    const response = await request(app()).get("/guarded").set("Authorization", header);

    expect(response.status).toBe(401);
    expect(response.body.message).toBe("Missing bearer token");
  });

  it("rejects a token that is not a JWT at all", async () => {
    const response = await request(app())
      .get("/guarded")
      .set("Authorization", "Bearer not-a-token");

    expect(response.status).toBe(401);
    expect(response.body.message).toMatch(/invalid or expired/i);
  });

  it("rejects a token signed with the wrong secret", async () => {
    // A refresh token is a well-formed JWT signed with the OTHER secret.
    const response = await request(app())
      .get("/guarded")
      .set("Authorization", `Bearer ${signRefreshToken(USER.sub)}`);

    expect(response.status).toBe(401);
    expect(response.body.message).toMatch(/invalid or expired/i);
  });

  /** The reason tokenService carries a `typ` claim.
   *
   *  A preview token is signed with the ACCESS secret and carries a `sub`, so
   *  without the type check its signature verifies and requireAuth would hand
   *  full API access to a credential that is deliberately given to untrusted
   *  code running inside a project container. */
  it("rejects a preview token presented as a bearer credential", async () => {
    const response = await request(app())
      .get("/guarded")
      .set("Authorization", `Bearer ${signPreviewToken(USER.sub)}`);

    expect(response.status).toBe(401);
    expect(response.body.message).toBe("Malformed access token");
  });

  it("does not leak one request's context into another", async () => {
    const other = { sub: "22222222-2222-4222-8222-222222222222", email: "b@example.com" };

    const [first, second] = await Promise.all([
      request(app()).get("/guarded").set("Authorization", `Bearer ${signAccessToken(USER)}`),
      request(app()).get("/guarded").set("Authorization", `Bearer ${signAccessToken(other)}`),
    ]);

    expect(first.body.userId).toBe(USER.sub);
    expect(second.body.userId).toBe(other.sub);
  });
});

describe("getAuthContext", () => {
  it("throws when requireAuth never ran for this request", () => {
    // A handler mounted without the guard is a programming error, not an
    // anonymous request — it must fail closed rather than return undefined.
    expect(() => getAuthContext({} as Request)).toThrow(UnauthorizedError);
  });
});
