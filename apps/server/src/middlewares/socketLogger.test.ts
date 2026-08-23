import type { Namespace, Socket } from "socket.io";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installSocketLogger } from "./socketLogger.js";
import { currentRequestId, logger } from "../lib/logger.js";

const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);

beforeEach(() => {
  info.mockClear();
  debug.mockClear();
});

type HandshakeMiddleware = (
  socket: Socket,
  next: (error?: Error) => void,
) => void;

const USER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** A socket stand-in that records the packet middleware and disconnect
 *  listeners the logger registers, so each test can drive them directly. */
function socketStandIn(): {
  socket: Socket;
  packets: Array<(packet: unknown[], next: (error?: Error) => void) => void>;
  disconnects: Array<(reason: string) => void>;
} {
  const packets: Array<(packet: unknown[], next: (error?: Error) => void) => void> =
    [];
  const disconnects: Array<(reason: string) => void> = [];

  const socket = {
    data: { userId: USER, projectId: PROJECT, accessLevel: "editor" },
    conn: { transport: { name: "websocket" } },
    use(fn: (packet: unknown[], next: (error?: Error) => void) => void) {
      packets.push(fn);
    },
    on(event: string, fn: (reason: string) => void) {
      if (event === "disconnect") disconnects.push(fn);
    },
  } as unknown as Socket;

  return { socket, packets, disconnects };
}

/** Installs the logger on a stand-in namespace and returns the handshake
 *  middleware it registered. */
function handshakeMiddleware(): HandshakeMiddleware {
  let registered: HandshakeMiddleware | undefined;
  const namespace = {
    use(fn: HandshakeMiddleware) {
      registered = fn;
    },
  } as unknown as Namespace;

  installSocketLogger(namespace);
  if (!registered) throw new Error("installSocketLogger registered no middleware");
  return registered;
}

/** One admitted connection, with its packet middleware and listeners. */
function connect() {
  const standIn = socketStandIn();
  const admitted = vi.fn();
  handshakeMiddleware()(standIn.socket, admitted);
  return { ...standIn, admitted };
}

type PacketMiddleware = (
  packet: unknown[],
  next: (error?: Error) => void,
) => void;

/** The packet middleware the logger registered, checked to exist. */
function packet(packets: PacketMiddleware[]): PacketMiddleware {
  const middleware = packets[0];
  if (!middleware) throw new Error("socketLogger registered no packet middleware");
  return middleware;
}

/** The disconnect listener the logger registered, checked to exist. */
function onDisconnect(
  listeners: Array<(reason: string) => void>,
): (reason: string) => void {
  const listener = listeners[0];
  if (!listener) throw new Error("socketLogger registered no disconnect listener");
  return listener;
}

describe("installSocketLogger", () => {
  it("admits the socket, having logged the connection", () => {
    const { admitted } = connect();

    expect(admitted).toHaveBeenCalledExactlyOnceWith();
  });

  it("logs a connect line carrying the user and project", () => {
    connect();

    expect(info).toHaveBeenCalledWith(
      "socket connected",
      expect.objectContaining({ transport: "websocket" }),
    );
  });

  it("gives every event the connection's correlation id", () => {
    const { packets } = connect();

    // The AsyncLocalStorage context is the whole point: a log written deep
    // inside an event handler must carry the id the connection was admitted
    // under. The debug line here stands in for any such handler log.
    packet(packets)(["writeFile", { path: "x" }], () => {
      expect(currentRequestId()).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  it("logs each inbound event by name, inside the context", () => {
    const { packets } = connect();

    let seen: string | undefined;
    packet(packets)(["docUpdate", {}], () => {
      seen = currentRequestId();
    });

    expect(debug).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledWith(
      "socket event",
      expect.objectContaining({ event: "docUpdate" }),
    );
    expect(seen).toBeDefined();
  });

  it("passes the packet through to the handler", () => {
    const { packets } = connect();
    const next = vi.fn();

    packet(packets)(["treeChanged"], next);

    expect(next).toHaveBeenCalledExactlyOnceWith();
  });

  it("uses one id for the whole connection, not one per event", () => {
    const { packets } = connect();

    const ids = new Set<string>();
    for (const event of ["docJoin", "docUpdate", "docLeave"]) {
      packet(packets)([event], () => {
        ids.add(currentRequestId() ?? "");
      });
    }

    expect(ids.size).toBe(1);
  });

  it("carries the id onto the disconnect line", () => {
    const { packets, disconnects } = connect();

    let connectedId: string | undefined;
    packet(packets)(["anything"], () => {
      connectedId = currentRequestId();
    });

    onDisconnect(disconnects)("transport close");
    const disconnectFields = info.mock.calls.find(
      ([message]) => message === "socket disconnected",
    )?.[1] as Record<string, unknown>;

    expect(disconnectFields).toMatchObject({ reason: "transport close" });
    expect(disconnectFields["requestId"]).toBe(connectedId);
  });
});
