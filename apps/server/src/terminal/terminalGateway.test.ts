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
      terminalId: number,
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
const increment = vi.hoisted(() => vi.fn<(name: string) => void>());
vi.mock("../lib/metrics.js", () => ({ increment }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
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
        expect.any(Number),
        // The project's own run command, so a shell's $START_COMMAND names the
        // same thing the Run button runs. Undefined when it has none.
        undefined,
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

  /** A shell outlives the socket that asked for one: nothing in the container
   *  knows the browser has gone, and everything that would tear it down hangs
   *  off the socket. React's StrictMode opens and immediately discards a
   *  socket on every mount in development, so this ran on every single mount,
   *  and the shells piled up for as long as the container lived. */
  describe("a client that leaves while the container is starting", () => {
    /** Opens a socket, closes it, and only then lets the container appear. */
    async function leaveDuringStartup(): Promise<void> {
      let releaseContainer: (() => void) | undefined;
      containerManager.ensureContainer.mockReturnValue(
        new Promise((resolve) => {
          releaseContainer = () => resolve({ id: "container-1" });
        }),
      );

      const { ws, outcome } = await openSocket();
      expect(outcome).toBe("open");

      ws.close();
      // The server has to have SEEN the close before the container arrives —
      // otherwise this proves nothing about the ordering it was written for.
      await vi.waitFor(() => expect(containerManager.detach).toHaveBeenCalled());

      releaseContainer?.();
      // Give the resumed startup every chance to open a shell anyway.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    it("opens no shell", async () => {
      await leaveDuringStartup();

      expect(handleTerminalCreation).not.toHaveBeenCalled();
    });

    /** The metric read 11 for a project that never held more than a couple of
     *  shells, because it counted sockets rather than shells. */
    it("is not counted as a terminal session", async () => {
      await leaveDuringStartup();

      expect(increment).not.toHaveBeenCalledWith("terminal_sessions");
    });

    it("releases the project's attachment exactly once", async () => {
      await leaveDuringStartup();

      expect(containerManager.detach).toHaveBeenCalledTimes(1);
    });
  });

  /** Attachments are a refcount that keeps the idle sweeper off a container in
   *  use. The failure path used to detach directly AND leave its close handler
   *  in place, so one failed terminal released somebody else's attachment. */
  it("releases the attachment once, not twice, when the container cannot start", async () => {
    containerManager.ensureContainer.mockRejectedValue(new Error("docker is down"));

    const { ws } = await openSocket();
    await nextClose(ws);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(containerManager.attach).toHaveBeenCalledTimes(1);
    expect(containerManager.detach).toHaveBeenCalledTimes(1);
  });
});
