import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import cookieParser from "cookie-parser";
import express from "express";
import { Server as SocketIoServer } from "socket.io";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPreviewProxy, installPreviewUpgrade, previewGuard } from "./preview.js";
import { errorHandler } from "../middlewares/errorHandler.js";
import { installTerminalGateway } from "../terminal/terminalGateway.js";
import {
  PREVIEW_COOKIE_NAME,
  signAccessToken,
  signPreviewToken,
} from "../service/tokenService.js";

/** How the three WebSocket owners on one HTTP server divide up the upgrades.
 *
 *  socket.io (the editor), the terminal gateway and the preview proxy all share
 *  a single listener. Nothing about that arrangement is enforced by types, and
 *  getting it wrong is not visible in any unit test: the preview proxy once
 *  attached an unfiltered `upgrade` handler of its own on the FIRST HTTP request
 *  it served, which then swallowed every /terminal upgrade for the rest of the
 *  process. The terminal worked until someone opened the preview panel, then
 *  died with a bare 1006 that named no cause.
 *
 *  These tests wire the real handlers onto a real server, in the real order, and
 *  drive real upgrade requests at it.
 */

const containerManager = vi.hoisted(() => ({
  ensureContainer: vi.fn(),
  getPreviewTarget: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
}));

const projectService = vi.hoisted(() => ({
  assertProjectAccess: vi.fn(),
  touchProject: vi.fn(),
}));

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const USER = "11111111-1111-4111-8111-111111111111";

const handleTerminalCreation = vi.hoisted(() => vi.fn());

vi.mock("../containers/containerManager.js", () => containerManager);
vi.mock("../service/projectService.js", () => projectService);
// The shell itself is dockerode's business and not what this suite is about;
// reaching this function at all is the proof that the upgrade was routed.
vi.mock("../containers/handleTerminalCreation.js", () => ({ handleTerminalCreation }));
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: {
      findUnique: vi.fn().mockResolvedValue({
        id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        template: "react-vite",
      }),
    },
  },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  withLogContext: <T>(_context: unknown, fn: () => T) => fn(),
  currentRequestId: () => undefined,
  newRequestId: () => "test",
  extendLogContext: () => undefined,
}));

/** Stands in for a project's dev server, so the preview proxy has somewhere
 *  real to forward to and its HTTP path genuinely completes. */
let devServer: HttpServer;
let server: HttpServer;
let io: SocketIoServer;
let port: number;
/** How many `upgrade` listeners the wiring itself installs. */
let wiredUpgradeListeners: number;

function listen(instance: HttpServer): Promise<number> {
  return new Promise((resolve) => {
    instance.listen(0, "127.0.0.1", () => {
      resolve((instance.address() as AddressInfo).port);
    });
  });
}

function close(instance: HttpServer | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!instance) {
      resolve();
      return;
    }
    instance.close(() => {
      resolve();
    });
  });
}

beforeAll(async () => {
  devServer = createServer((req, res) => {
    const headers: Record<string, string> = { "Content-Type": "text/html" };
    // The stand-in for a compromised sandbox: markup that tries to relax the
    // framing policy and smuggle in a permissive CSP of its own.
    if (req.url?.includes("hostile")) {
      headers["Content-Security-Policy"] =
        "frame-ancestors *; base-uri *; object-src *";
      headers["X-Frame-Options"] = "DENY";
    }
    res.writeHead(200, headers);
    res.end("<h1>dev server</h1>");
  });
  const devPort = await listen(devServer);

  containerManager.ensureContainer.mockResolvedValue({ id: "container" });
  containerManager.getPreviewTarget.mockResolvedValue(`http://127.0.0.1:${String(devPort)}`);
  projectService.assertProjectAccess.mockResolvedValue({
    id: PROJECT,
    template: "react-vite",
  });
  projectService.touchProject.mockResolvedValue(undefined);

  // --- Exactly the wiring in index.ts, in the same order ------------------
  const app = express();
  // previewGuard reads the preview token from req.cookies, which only exists
  // once cookie-parser has run — same order as index.ts.
  app.use(cookieParser());
  server = createServer(app);

  io = new SocketIoServer(server, {
    // engine.io destroys any upgrade it does not recognise; the terminal shares
    // this server, so that default would kill every /terminal upgrade.
    destroyUpgrade: false,
  });

  const previewProxy = createPreviewProxy();
  app.use("/preview/:projectId", previewGuard, previewProxy);
  // As in index.ts, so error responses go through OUR handler — Express's own
  // finalhandler would replace the guard's CSP with `default-src 'none'`.
  app.use(errorHandler);

  installTerminalGateway(server);
  installPreviewUpgrade(server, previewProxy);

  // Captured here, before any request has been served: the proxy subscribes on
  // the first request it handles, so a baseline taken inside a test would
  // already include the very listener we are looking for.
  wiredUpgradeListeners = server.listenerCount("upgrade");

  port = await listen(server);
});

afterAll(async () => {
  for (const socket of openSockets) socket.destroy();
  await io.close();
  await close(server);
  await close(devServer);
});

afterEach(() => {
  containerManager.ensureContainer.mockClear();
  handleTerminalCreation.mockClear();
});

const previewCookie = () =>
  `${PREVIEW_COOKIE_NAME}=${encodeURIComponent(signPreviewToken(USER))}`;

/** Sends a raw WebSocket upgrade and returns what the server said back.
 *
 *  Raw rather than a WebSocket client on purpose: a client reports a hijacked
 *  upgrade as close code 1006 and hides everything that matters. At this level
 *  the difference between "the right handler answered 401" and "some other
 *  handler destroyed the socket" is plainly visible.
 */
function rawUpgrade(
  path: string,
  headers: Record<string, string> = {},
  /** Keep listening this long after the response headers arrive.
   *
   *  A handshake that succeeds and is then torn down is the failure that
   *  mattered most: the browser reports it as an open socket followed by a bare
   *  1006, which is what "terminal disconnected" looked like from the outside.
   *  Reading only the status line would call that a pass. */
  holdMs = 0,
): Promise<{ response: string; destroyed: boolean; closedAfterResponse: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let response = "";
    let settled = false;
    let headersDone = false;
    let closedAfterResponse = false;

    const finish = (destroyed: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ response, destroyed, closedAfterResponse });
    };

    socket.setTimeout(3000, () => {
      finish(false);
    });

    socket.on("connect", () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${String(port)}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        "Sec-WebSocket-Version: 13",
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "",
        "",
      ];
      socket.write(lines.join("\r\n"));
    });

    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      if (headersDone || !response.includes("\r\n\r\n")) return;

      headersDone = true;
      if (holdMs === 0) finish(false);
      else setTimeout(() => finish(false), holdMs);
    });

    // A hijacked upgrade shows up here: either the socket dies with nothing
    // written, or it dies moments after a handshake that looked successful.
    socket.on("close", () => {
      closedAfterResponse = headersDone;
      finish(response.length === 0);
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNRESET") {
        closedAfterResponse = headersDone;
        finish(response.length === 0);
        return;
      }
      if (!settled) reject(error);
    });
  });
}

/** Sockets left open by `get`, torn down once the suite is finished. */
const openSockets: net.Socket[] = [];

/** An ordinary HTTP GET, used to make the preview proxy serve a request — which
 *  is the moment the old bug armed itself.
 *
 *  Deliberately keep-alive, and the socket is deliberately left open. The
 *  library reads the server object off `req.socket` AFTER the response has been
 *  written; with `Connection: close` the socket is already gone by then and
 *  `req.socket` is null, so the very subscription this suite exists to detect
 *  never happens and the test passes for the wrong reason. A browser holds the
 *  connection open, so this does too.
 */
async function get(path: string, headers: Record<string, string> = {}): Promise<number> {
  const status = await getResponse(path, headers).then((response) =>
    /^HTTP\/1\.1 (\d{3})/.exec(response)?.[1],
  );
  if (!status) throw new Error("no status line in the response");
  return Number(status);
}

/** The same request as `get`, but returns the whole response — headers
 *  included, which is what the CSP assertions need to see. */
async function getResponse(
  path: string,
  headers: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    openSockets.push(socket);
    let response = "";

    socket.on("connect", () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${String(port)}`,
          "Connection: keep-alive",
          ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
          "",
          "",
        ].join("\r\n"),
      );
    });

    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      if (response.includes("\r\n\r\n")) resolve(response);
    });

    socket.on("close", () => {
      reject(new Error(`connection closed before a response: ${response.slice(0, 200)}`));
    });
    socket.on("error", reject);
  });
}

/** Lets the server finish the work it does AFTER the response is written.
 *
 *  http-proxy-middleware subscribes to the server's `upgrade` event at the very
 *  end of its async middleware, once the proxied response has already been
 *  sent — so a client that has seen the whole response has not necessarily seen
 *  that subscription happen yet. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
}

describe("preview proxy HTTP path", () => {
  it("serves the project's dev server through /preview/:projectId", async () => {
    const status = await get(`/preview/${PROJECT}/`, { Cookie: previewCookie() });

    expect(status).toBe(200);
    expect(containerManager.ensureContainer).toHaveBeenCalledWith(PROJECT);
  });
});

describe("upgrade routing", () => {
  /** The regression test for the bug that killed the terminal.
   *
   *  The preview proxy must serve HTTP without ever claiming an upgrade it was
   *  not given. If it attaches a listener of its own, that listener has no path
   *  filter and routes /terminal to the router's dead-end fallback.
   */
  it("does not let a served preview request add an upgrade listener", async () => {
    // Three, and only ever three: socket.io, the terminal gateway, and the
    // path-scoped preview handler.
    expect(wiredUpgradeListeners).toBe(3);

    await get(`/preview/${PROJECT}/`, { Cookie: previewCookie() });
    await get(`/preview/${PROJECT}/index.html`, { Cookie: previewCookie() });
    await settle();

    expect(server.listenerCount("upgrade")).toBe(wiredUpgradeListeners);
  });

  /** The exact sequence that broke the terminal in production.
   *
   *  It has to use a REAL token: the gateway authorises against the database
   *  before completing the handshake, so an authorised upgrade waits on a
   *  promise while an unauthorised one is rejected in the first microtask. Only
   *  the authorised path is slow enough to lose the race to an unfiltered
   *  listener — which is precisely why the terminal failed for signed-in users
   *  and looked fine in any quick check.
   */
  it("completes an authorised /terminal upgrade after the preview panel has loaded", async () => {
    await get(`/preview/${PROJECT}/`, { Cookie: previewCookie() });
    await settle();

    const { response, destroyed, closedAfterResponse } = await rawUpgrade(
      `/terminal?projectId=${PROJECT}`,
      { "Sec-WebSocket-Protocol": `auth, ${signAccessToken({ sub: USER, email: "a@example.com" })}` },
      300,
    );

    expect(destroyed).toBe(false);
    expect(response).toContain("101 Switching Protocols");
    // And it stays up. The unfiltered listener let the handshake finish and
    // then killed the socket a moment later, which is the "connected, then
    // disconnected for no reason" the user actually saw.
    expect(closedAfterResponse).toBe(false);
    expect(handleTerminalCreation).toHaveBeenCalled();
  });

  it("completes an authorised /terminal upgrade on its own", async () => {
    const { response, destroyed, closedAfterResponse } = await rawUpgrade(
      `/terminal?projectId=${PROJECT}`,
      { "Sec-WebSocket-Protocol": `auth, ${signAccessToken({ sub: USER, email: "a@example.com" })}` },
      300,
    );

    expect(destroyed).toBe(false);
    expect(response).toContain("101 Switching Protocols");
    expect(closedAfterResponse).toBe(false);
  });

  it("rejects an unauthenticated /terminal upgrade with a 401 it can read", async () => {
    const { response, destroyed } = await rawUpgrade(
      `/terminal?projectId=${PROJECT}`,
    );

    // A refusal the browser can see. A hijacked upgrade destroys the socket in
    // silence instead, which reaches the browser as an unexplained 1006.
    expect(destroyed).toBe(false);
    expect(response).toContain("401 Unauthorized");
  });

  it("leaves socket.io's own upgrades to engine.io", async () => {
    await get(`/preview/${PROJECT}/`, { Cookie: previewCookie() });
    await settle();

    const { response } = await rawUpgrade("/socket.io/?EIO=4&transport=websocket");

    // engine.io completes the handshake itself; neither the terminal nor the
    // preview may intercept it.
    expect(response).toContain("101 Switching Protocols");
  });

  it("still routes an authorised preview upgrade to the dev server", async () => {
    // The other direction: removing the proxy's own `ws` handling must not cost
    // us the explicit, path-scoped one that Vite's HMR socket depends on.
    const { response, destroyed } = await rawUpgrade(`/preview/${PROJECT}/@vite-hmr`, {
      Cookie: previewCookie(),
    });

    // The stand-in dev server does not speak WebSocket, so the handshake fails —
    // but it fails at the dev server, which means the upgrade was authorised and
    // forwarded rather than rejected here.
    expect(destroyed).toBe(false);
    expect(response).not.toContain("401 Unauthorized");
  });

  it("rejects a preview upgrade with no cookie", async () => {
    const { response } = await rawUpgrade(`/preview/${PROJECT}/@vite-hmr`);

    expect(response).toContain("401 Unauthorized");
  });

  it("rejects a terminal upgrade naming a projectId that is not a uuid", async () => {
    const { response } = await rawUpgrade("/terminal?projectId=../../etc");

    expect(response).toContain("401 Unauthorized");
  });
});

describe("preview CSP", () => {
  /** The one CSP header a preview response carries, out of the raw response. */
  function cspHeader(response: string): string[] {
    return [...response.matchAll(/content-security-policy: ?([^\r\n]*)/gi)].map(
      (match) => match[1] ?? "",
    );
  }

  it("answers hostile dev-server markup with the platform's CSP, not the sandbox's", async () => {
    const response = await getResponse(`/preview/${PROJECT}/hostile.html`, {
      Cookie: previewCookie(),
    });

    // Exactly one CSP — ours — and every directive in it is the platform's.
    const headers = cspHeader(response);
    expect(headers).toHaveLength(1);
    expect(headers[0]).toContain("frame-ancestors 'self'");
    expect(headers[0]).toContain("base-uri 'self'");
    expect(headers[0]).toContain("object-src 'none'");
    // The sandbox's attempts to speak for itself are dropped, headers and all.
    expect(headers[0]).not.toContain("frame-ancestors *");
    expect(response).not.toMatch(/x-frame-options/i);
  });

  it("carries the same CSP on responses the guard answers itself", async () => {
    // No cookie: the guard refuses before the proxy is ever reached, and its
    // refusal is still a document served into the editor's iframe.
    const response = await getResponse(`/preview/${PROJECT}/`);

    expect(await get(`/preview/${PROJECT}/`)).toBe(401);
    const headers = cspHeader(response);
    expect(headers).toHaveLength(1);
    expect(headers[0]).toContain("object-src 'none'");
  });
});
