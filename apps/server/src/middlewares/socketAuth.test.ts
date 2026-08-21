import type { Namespace, Socket } from "socket.io";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installSocketAuth } from "./socketAuth.js";
import {
  signAccessToken,
  signPreviewToken,
  signRefreshToken,
} from "../service/tokenService.js";

const getProjectAccess = vi.hoisted(() => vi.fn());

vi.mock("../service/projectAccessService.js", () => ({ getProjectAccess }));

const USER = { sub: "11111111-1111-4111-8111-111111111111", email: "a@example.com" };
const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

type Middleware = (socket: Socket, next: (error?: Error) => void) => void;

/** Installs the guard on a stand-in namespace and returns the middleware it
 *  registered, so each case can drive one handshake directly. */
function guard(): Middleware {
  let registered: Middleware | undefined;

  const namespace = {
    use(fn: Middleware) {
      registered = fn;
    },
  } as unknown as Namespace;

  installSocketAuth(namespace);
  if (!registered) throw new Error("installSocketAuth registered no middleware");
  return registered;
}

interface Handshake {
  token?: string;
  authorization?: string;
  projectId?: unknown;
}

/** Runs one handshake and resolves with the error the guard passed to next
 *  (undefined when it admitted the socket), plus the socket it populated. */
async function handshake(
  input: Handshake,
): Promise<{ error?: Error; data: Record<string, unknown> }> {
  const data: Record<string, unknown> = {};

  const socket = {
    data,
    handshake: {
      auth: input.token === undefined ? {} : { token: input.token },
      headers: input.authorization ? { authorization: input.authorization } : {},
      query: input.projectId === undefined ? {} : { projectId: input.projectId },
    },
  } as unknown as Socket;

  return new Promise((resolve) => {
    guard()(socket, (error?: Error) => {
      resolve({ error, data });
    });
  });
}

beforeEach(() => {
  getProjectAccess.mockReset();
});

describe("installSocketAuth", () => {
  it("admits an editor and records who they are on the socket", async () => {
    getProjectAccess.mockResolvedValue({ level: "editor" });

    const { error, data } = await handshake({
      token: signAccessToken(USER),
      projectId: PROJECT,
    });

    expect(error).toBeUndefined();
    expect(data).toEqual({
      userId: USER.sub,
      projectId: PROJECT,
      accessLevel: "editor",
    });
  });

  /** Read-only access exists so somebody can look at a project; refusing the
   *  connection outright would make it unusable. Which events a viewer may then
   *  send is the handler's decision, from the level recorded here. */
  it("admits a viewer, leaving the level for the handlers to enforce", async () => {
    getProjectAccess.mockResolvedValue({ level: "viewer" });

    const { error, data } = await handshake({
      token: signAccessToken(USER),
      projectId: PROJECT,
    });

    expect(error).toBeUndefined();
    expect(data["accessLevel"]).toBe("viewer");
  });

  it("accepts the token from an Authorization header too", async () => {
    getProjectAccess.mockResolvedValue({ level: "owner" });

    const { error, data } = await handshake({
      authorization: `Bearer ${signAccessToken(USER)}`,
      projectId: PROJECT,
    });

    expect(error).toBeUndefined();
    expect(data["userId"]).toBe(USER.sub);
  });

  it("rejects a handshake carrying no token", async () => {
    const { error, data } = await handshake({ projectId: PROJECT });

    expect(error?.message).toMatch(/^UNAUTHORIZED/);
    expect(data).toEqual({});
    expect(getProjectAccess).not.toHaveBeenCalled();
  });

  it.each([
    ["a malformed token", "not-a-jwt"],
    ["a refresh token", signRefreshToken(USER.sub)],
    // Signed with the access secret, so only the `typ` claim tells them apart.
    ["a preview token", signPreviewToken(USER.sub)],
  ])("rejects %s", async (_label, token) => {
    const { error, data } = await handshake({ token, projectId: PROJECT });

    expect(error).toBeInstanceOf(Error);
    expect(data).toEqual({});
    expect(getProjectAccess).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["an array of ids", ["a", "b"]],
  ])("rejects a projectId that is %s", async (_label, projectId) => {
    const { error } = await handshake({
      token: signAccessToken(USER),
      ...(projectId === undefined ? {} : { projectId }),
    });

    expect(error?.message).toMatch(/^BAD_REQUEST/);
    expect(getProjectAccess).not.toHaveBeenCalled();
  });

  /** Reported as NOT_FOUND rather than FORBIDDEN on purpose: telling a stranger
   *  that a project exists but is not theirs is more than they need to know. */
  it.each([
    ["no access record", null],
    ["an explicit level of none", { level: "none" }],
  ])("rejects a project the user has %s for", async (_label, access) => {
    getProjectAccess.mockResolvedValue(access);

    const { error, data } = await handshake({
      token: signAccessToken(USER),
      projectId: PROJECT,
    });

    expect(error?.message).toMatch(/^NOT_FOUND/);
    expect(data).toEqual({});
  });

  it("checks access for the id the client named, against the token's subject", async () => {
    getProjectAccess.mockResolvedValue({ level: "editor" });

    await handshake({ token: signAccessToken(USER), projectId: PROJECT });

    expect(getProjectAccess).toHaveBeenCalledWith(PROJECT, USER.sub);
  });

  it("surfaces a failure from the access lookup as an error, never an admit", async () => {
    getProjectAccess.mockRejectedValue(new Error("database is down"));

    const { error, data } = await handshake({
      token: signAccessToken(USER),
      projectId: PROJECT,
    });

    expect(error).toBeInstanceOf(Error);
    expect(data).toEqual({});
  });
});
