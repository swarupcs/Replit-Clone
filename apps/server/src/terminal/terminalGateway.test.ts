import http from "node:http";
import { PassThrough } from "node:stream";
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

/** The reconnect path, which starts no exec at all — it binds a new socket to
 *  a session that is already running. plan.md §13.7. */
const bindSocketToSession = vi.hoisted(() => vi.fn());

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
  vi.fn<(id: string, connection: WatchedConnection) => () => void>(
    () => () => {
      // release, by default a no-op
    },
  ),
);

vi.mock("../containers/containerManager.js", () => containerManager);
vi.mock("../containers/handleTerminalCreation.js", () => ({
  handleTerminalCreation,
  bindSocketToSession,
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
import {
  Scrollback,
  findSession,
  registerSession,
  resetSessionsForTest,
} from "./terminalSessions.js";
import type { TerminalSession } from "./terminalSessions.js";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const USER = { sub: "11111111-1111-4111-8111-111111111111", email: "a@example.com" };

/** A session already running, as the reconnect path would find one. Only the
 *  fields the gateway reads are real; the exec and the stream behind a live
 *  one are `handleTerminalCreation`'s business and are tested there. */
function fakeSession(id: string, projectId: string): TerminalSession {
  return {
    id,
    projectId,
    terminalId: 1,
    ws: null,
    detachedAt: Date.now(),
    graceTimer: null,
    ended: false,
    reattachable: true,
    release: () => undefined,
    scrollback: new Scrollback(1024),
    stream: new PassThrough(),
  } as unknown as TerminalSession;
}

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
  /** What the client calls this terminal, so a reconnect can ask for the shell
   *  it already had. Absent by default, which is the pre-§13.7 client. */
  sessionKey?: string,
): Promise<{ ws: WebSocket; outcome: "open" | "rejected"; code?: number; reason?: string }> {
  const query =
    projectId === null
      ? ""
      : `?projectId=${projectId}${sessionKey ? `&session=${sessionKey}` : ""}`;

  const ws = new WebSocket(projectId === null ? url : `${url}${query}`, protocols);
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
        // No session, because this socket named none: an unnamed terminal
        // keeps the lifecycle it had before §13.7.
        undefined,
        // No shell either: this project has no `.vscode/settings.json` naming
        // one, so the terminal opens on the default. plan.md §10.14.
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

/** plan.md §13.7. The gateway's half of a terminal that survives a
 *  disconnect: deciding whether a socket is a new terminal or one coming
 *  back, and refusing to let one person's key reach another person's shell. */
describe("a socket that names its terminal", () => {
  const KEY = "abcdefgh-1234";

  afterEach(() => {
    resetSessionsForTest();
  });

  it("passes the session on so the shell can outlive this socket", async () => {
    const { outcome } = await openSocket(authProtocols(), PROJECT, KEY);

    expect(outcome).toBe("open");
    await vi.waitFor(() =>
      expect(handleTerminalCreation).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "node",
        expect.any(Function),
        expect.any(Number),
        undefined,
        expect.objectContaining({
          id: `${USER.sub}:${PROJECT}:${KEY}`,
          projectId: PROJECT,
        }),
        // The shell, from `.vscode/settings.json` when there is one. §10.14.
        undefined,
      ),
    );
  });

  it("reattaches to a running session instead of starting a second shell", async () => {
    registerSession(fakeSession(`${USER.sub}:${PROJECT}:${KEY}`, PROJECT));

    const { outcome } = await openSocket(authProtocols(), PROJECT, KEY);

    expect(outcome).toBe("open");
    await vi.waitFor(() => expect(bindSocketToSession).toHaveBeenCalled());

    // The point of the reconnect path: no exec, and — just as important — no
    // `ensureContainer`, because the session is what is holding that container
    // up in the first place.
    expect(handleTerminalCreation).not.toHaveBeenCalled();
    expect(containerManager.ensureContainer).not.toHaveBeenCalled();
  });

  it("does not let one person's key reach another person's shell", async () => {
    // Registered under a DIFFERENT user, with the same project and the same
    // client key. The user id is part of the session id rather than something
    // compared afterwards, so this cannot resolve — it looks up nothing.
    registerSession(
      fakeSession(`22222222-2222-4222-8222-222222222222:${PROJECT}:${KEY}`, PROJECT),
    );

    const { outcome } = await openSocket(authProtocols(), PROJECT, KEY);

    expect(outcome).toBe("open");
    await vi.waitFor(() => expect(handleTerminalCreation).toHaveBeenCalled());
    expect(bindSocketToSession).not.toHaveBeenCalled();
  });

  it("treats a malformed key as no key at all", async () => {
    // An old client, a browser that could not store one, or somebody probing.
    // Refusing would break a client that works; this gives it a terminal that
    // simply does not survive a disconnect.
    const { outcome } = await openSocket(authProtocols(), PROJECT, "short");

    expect(outcome).toBe("open");
    await vi.waitFor(() =>
      expect(handleTerminalCreation).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "node",
        expect.any(Function),
        expect.any(Number),
        undefined,
        undefined,
        undefined,
      ),
    );
  });

  it("gives each socket its own access watch, not one per terminal", async () => {
    const released: string[] = [];
    const registered: string[] = [];
    watchAccess.mockImplementation((id) => {
      registered.push(id);
      return () => released.push(id);
    });

    const id = `${USER.sub}:${PROJECT}:${KEY}`;
    registerSession(fakeSession(id, PROJECT));

    const first = await openSocket(authProtocols(), PROJECT, KEY);
    await vi.waitFor(() => expect(registered).toHaveLength(1));

    const second = await openSocket(authProtocols(), PROJECT, KEY);
    await vi.waitFor(() => expect(registered).toHaveLength(2));

    // The watch used to be keyed `terminal:<terminalId>`, which was right
    // while a terminal had one socket for its whole life. A reconnect gives it
    // two, and `watchAccess` is a map whose release deletes the key — so the
    // departing socket deleted the watch belonging to the one that replaced
    // it, leaving a live shell nothing was checking.
    expect(new Set(registered).size).toBe(2);

    first.ws.close();
    await vi.waitFor(() => expect(released).toHaveLength(1));
    expect(released[0]).toBe(registered[0]);
    expect(released).not.toContain(registered[1]);

    second.ws.close();
  });

  it("ends the session when access is revoked, not just the socket", async () => {
    let revoked: (() => void) | undefined;
    watchAccess.mockImplementation((_id, connection) => {
      revoked = connection.onRevoked;
      return () => undefined;
    });

    const id = `${USER.sub}:${PROJECT}:${KEY}`;
    registerSession(fakeSession(id, PROJECT));

    const { ws, outcome } = await openSocket(authProtocols(), PROJECT, KEY);
    expect(outcome).toBe("open");
    await vi.waitFor(() => expect(revoked).toBeDefined());

    const closed = nextClose(ws);
    revoked?.();
    expect((await closed).code).toBe(4403);

    // Closing the socket WAS ending the shell before §13.7. It is not any
    // more, so a revocation that only closed the socket would leave a shell
    // inside a container belonging to somebody who has just lost access to it
    // — and hand it back if they reconnected inside the grace window.
    expect(findSession(id)).toBeUndefined();
  });
});
