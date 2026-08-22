import http from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const containerManager = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  ensureContainer: vi.fn(() => Promise.resolve({ id: "container-1" })),
}));

const handleTerminalCreation = vi.hoisted(() =>
  vi.fn<
    (
      container: unknown,
      ws: unknown,
      templateId: string,
      attachInput: (handler: (data: string) => void) => void,
    ) => void
  >(),
);

const projectService = vi.hoisted(() => ({
  assertProjectAccess: vi.fn<() => Promise<{ id: string; template: string }>>(
    () => Promise.resolve({ id: "p", template: "node" }),
  ),
  touchProject: vi.fn(() => Promise.resolve(undefined)),
}));

/** Just the part of the access watch the gateway touches. */
interface WatchedConnection {
  onRevoked: () => void;
}

const watchAccess = vi.hoisted(() =>
  vi.fn<
    (id: string, connection: WatchedConnection) => () => void
  >(() => () => {
    // release, by default a no-op
  }),
);

vi.mock("../containers/containerManager.js", () => containerManager);
vi.mock("../containers/handleTerminalCreation.js", () => ({
  handleTerminalCreation,
}));
vi.mock("../service/projectService.js", () => projectService);
vi.mock("../service/accessWatch.js", () => ({ watchAccess }));
vi.mock("../lib/metrics.js", () => ({ increment: vi.fn() }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { installTerminalGateway } from "./terminalGateway.js";
import { signAccessToken } from "../service/tokenService.js";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const USER = { sub: "11111111-1111-4111-8111-111111111111", email: "a@example.com" };

/** The terminal reads the token from the WebSocket subprotocol list, after the
 *  literal "auth" marker — nothing else may carry it. */
function authProtocols(): string[] {
  return ["auth", signAccessToken(USER)];
}

let server: http.Server;
let url: string;
/** Every client this suite opened, so afterEach can tear them down before the
 *  server waits on them forever. */
const sockets = new Set<WebSocket>();

beforeEach(async () => {
  vi.clearAllMocks();
  projectService.assertProjectAccess.mockResolvedValue({ id: PROJECT, template: "node" });
  containerManager.ensureContainer.mockResolvedValue({ id: "container-1" });
  handleTerminalCreation.mockImplementation(() => undefined);

  server = http.createServer(() => {
    // Plain HTTP requests are not the gateway's business.
  });
  installTerminalGateway(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}/terminal`;
});

afterEach(async () => {
  for (const ws of sockets) ws.terminate();
  sockets.clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Opens a terminal socket; resolves "open" once connected, or "rejected"
 *  (with the close code) when the server refuses at or after the upgrade. */
function openSocket(
  protocols: string[] = authProtocols(),
  projectId: string | null = PROJECT,
): Promise<{ ws: WebSocket; outcome: "open" | "rejected"; code?: number; reason?: string }> {
  const ws = new WebSocket(
    projectId === null ? url : `${url}?projectId=${projectId}`,
    protocols,
  );
  sockets.add(ws);

  return new Promise((resolve) => {
    ws.on("open", () => resolve({ ws, outcome: "open" }));
    ws.on("error", () => resolve({ ws, outcome: "rejected" }));
    ws.on("close", (code, reason) =>
      resolve({ ws, outcome: "rejected", code, reason: reason.toString() }),
    );
  });
}

/** Resolves with the code and reason of a socket's next close. */
function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) =>
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
}

describe("installTerminalGateway", () => {
  it("admits an editor and starts a terminal in the project's container", async () => {
    const { ws, outcome } = await openSocket();

    expect(outcome).toBe("open");
    await vi.waitFor(() =>
      expect(handleTerminalCreation).toHaveBeenCalledWith(
        expect.objectContaining({ id: "container-1" }),
        expect.anything(),
        "node",
        expect.any(Function),
      ),
    );
    expect(projectService.assertProjectAccess).toHaveBeenCalledWith(
      PROJECT,
      USER.sub,
      "editor",
    );
    ws.close();
  });

  it("rejects an upgrade with no token", async () => {
    const { outcome } = await openSocket(["auth"]);
    expect(outcome).toBe("rejected");
  });

  it("rejects a token that is not valid", async () => {
    const { outcome } = await openSocket(["auth", "not-a-jwt"]);
    expect(outcome).toBe("rejected");
  });

  it("rejects an invalid project id", async () => {
    const { outcome } = await openSocket(authProtocols(), "nonsense");
    expect(outcome).toBe("rejected");
  });

  /** A shell can write anything the project can, so read-only access does not
   *  earn one. */
  it("rejects a viewer", async () => {
    projectService.assertProjectAccess.mockRejectedValue(new Error("not allowed"));

    const { outcome } = await openSocket();
    expect(outcome).toBe("rejected");
  });

  /** The container and exec start asynchronously, but the terminal sends its
   *  initial resize the moment it connects — early input must queue, in order,
   *  until there is a PTY to hand it to. */
  it("buffers input that arrives before the container is ready", async () => {
    let releaseContainer: (() => void) | undefined;
    containerManager.ensureContainer.mockReturnValue(
      new Promise((resolve) => {
        releaseContainer = () => resolve({ id: "container-1" });
      }),
    );

    const { ws, outcome } = await openSocket();
    expect(outcome).toBe("open");

    const received: string[] = [];
    handleTerminalCreation.mockImplementation((_c, _w, _t, attachInput) => {
      attachInput((data: string) => received.push(data));
    });

    ws.send("resize:80x24");
    ws.send("ls\r");
    releaseContainer?.();

    await vi.waitFor(() => expect(received).toEqual(["resize:80x24", "ls\r"]));
    ws.close();
  });

  /** Access was checked once at the upgrade and never again; the watch is what
   *  tears the shell down when it is revoked mid-session. */
  it("closes the shell with 4403 when access is revoked", async () => {
    let revoked: (() => void) | undefined;
    watchAccess.mockImplementation((_id, connection) => {
      revoked = connection.onRevoked;
      return () => undefined;
    });

    const { ws, outcome } = await openSocket();
    expect(outcome).toBe("open");
    await vi.waitFor(() => expect(revoked).toBeDefined());

    const closed = nextClose(ws);
    revoked?.();

    const event = await closed;
    expect(event.code).toBe(4403);
  });

  it("closes with the reason when the container cannot start", async () => {
    containerManager.ensureContainer.mockRejectedValue(new Error("docker is down"));

    const { ws, outcome } = await openSocket();
    expect(outcome).toBe("open");

    // A bare "Disconnected" tells the user nothing; the close reason carries it.
    const event = await nextClose(ws);
    expect(event.code).toBe(1011);
    expect(event.reason).toBe("Could not start the project container");
  });
});
