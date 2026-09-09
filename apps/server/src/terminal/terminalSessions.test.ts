import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

const hangUpShell = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../containers/terminalShell.js", () => ({ hangUpShell }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/metrics.js", () => ({ increment: vi.fn() }));

const envMock = vi.hoisted(() => ({
  TERMINAL_DETACH_GRACE_SECONDS: 1800,
  TERMINAL_SCROLLBACK_BYTES: 4096,
  TERMINAL_MAX_SESSIONS_PER_PROJECT: 3,
}));
vi.mock("../config/env.js", () => ({ env: envMock }));

import {
  Scrollback,
  attachSocket,
  detachSocket,
  endProjectSessions,
  endSession,
  endUserSessions,
  findSession,
  isValidClientKey,
  makeRoomForSession,
  projectSessions,
  registerSession,
  resetSessionsForTest,
  sessionId,
} from "./terminalSessions.js";
import type { TerminalSession } from "./terminalSessions.js";

function fakeSocket(readyState = 1) {
  // The spy is handed back beside the socket rather than read off it, because
  // reading `ws.close` off the object to assert on it is an unbound method.
  const close = vi.fn();
  const ws = {
    OPEN: 1,
    readyState,
    bufferedAmount: 0,
    send: vi.fn(),
    close,
  } as unknown as WebSocket;

  return Object.assign(ws, { closeSpy: close });
}

function makeSession(
  id: string,
  overrides: Partial<TerminalSession> = {},
): TerminalSession {
  const session = {
    id,
    projectId: "p1",
    terminalId: 1,
    pidFile: `/tmp/rc-term-1-${id}.pid`,
    container: {} as never,
    exec: { resize: vi.fn(() => Promise.resolve()) } as never,
    stream: new PassThrough(),
    ws: null,
    scrollback: new Scrollback(envMock.TERMINAL_SCROLLBACK_BYTES),
    settled: false,
    detachedAt: null,
    graceTimer: null,
    release: vi.fn(),
    reattachable: true,
    ended: false,
    ...overrides,
  };

  registerSession(session);
  return session;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  envMock.TERMINAL_DETACH_GRACE_SECONDS = 1800;
  envMock.TERMINAL_MAX_SESSIONS_PER_PROJECT = 3;
});

afterEach(() => {
  resetSessionsForTest();
  vi.useRealTimers();
});

describe("client session keys", () => {
  it("accepts the shape the web app mints", () => {
    expect(isValidClientKey("3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBe(true);
    expect(isValidClientKey("t1a2b3c4-abcdefghij")).toBe(true);
  });

  it("refuses anything that could not be a name", () => {
    // Bounded and alphabet-restricted: the id ends up in log lines and in a
    // map key, and neither wants arbitrary client bytes.
    expect(isValidClientKey("")).toBe(false);
    expect(isValidClientKey("short")).toBe(false);
    expect(isValidClientKey("a".repeat(65))).toBe(false);
    expect(isValidClientKey("../../etc/passwd")).toBe(false);
    expect(isValidClientKey("key with spaces")).toBe(false);
    expect(isValidClientKey("$(rm -rf /)aaaa")).toBe(false);
  });

  it("scopes a session to one person on one project", () => {
    // The user id is IN the key rather than compared afterwards, so a valid
    // key presented by the wrong person resolves to nothing rather than
    // failing a check somebody could forget to write.
    expect(sessionId("u1", "p1", "k1")).not.toBe(sessionId("u2", "p1", "k1"));
    expect(sessionId("u1", "p1", "k1")).not.toBe(sessionId("u1", "p2", "k1"));
  });
});

describe("scrollback", () => {
  it("keeps what was written while nobody was attached", () => {
    const buffer = new Scrollback(1024);
    buffer.write(Buffer.from("one "));
    buffer.write(Buffer.from("two"));

    expect(buffer.read()?.toString()).toBe("one two");
  });

  it("drops the oldest rather than growing without limit", () => {
    const buffer = new Scrollback(8);
    buffer.write(Buffer.from("aaaaa"));
    buffer.write(Buffer.from("bbbbb"));

    expect(buffer.size).toBeLessThanOrEqual(8);
    expect(buffer.read()?.toString()).toBe("bbbbb");
  });

  it("keeps the tail of a chunk bigger than the whole budget", () => {
    // The end of a build's output is the half worth having.
    const buffer = new Scrollback(4);
    buffer.write(Buffer.from("abcdefgh"));

    expect(buffer.read()?.toString()).toBe("efgh");
  });

  it("is empty rather than an empty buffer when nothing happened", () => {
    expect(new Scrollback(16).read()).toBeNull();
  });
});

describe("detaching", () => {
  it("keeps the shell and starts the clock", () => {
    const ws = fakeSocket();
    const session = makeSession("u1:p1:k1");
    attachSocket(session, ws);

    detachSocket(session, ws);

    expect(hangUpShell).not.toHaveBeenCalled();
    expect(findSession("u1:p1:k1")).toBeDefined();
    expect(session.detachedAt).not.toBeNull();
  });

  it("hangs the shell up when the window expires", () => {
    const ws = fakeSocket();
    const session = makeSession("u1:p1:k1");
    attachSocket(session, ws);
    detachSocket(session, ws);

    vi.advanceTimersByTime(1800 * 1000);

    // The leak the 2026-09-04 container fix closed stays closed. It closes
    // later, not never.
    expect(hangUpShell).toHaveBeenCalledTimes(1);
    expect(findSession("u1:p1:k1")).toBeUndefined();
  });

  it("hangs up at once when the deployment set the window to zero", () => {
    envMock.TERMINAL_DETACH_GRACE_SECONDS = 0;
    const ws = fakeSocket();
    const session = makeSession("u1:p1:k1");
    attachSocket(session, ws);

    detachSocket(session, ws);

    // Exactly the behaviour this replaced, available without patching code.
    expect(hangUpShell).toHaveBeenCalledTimes(1);
  });

  it("hangs up at once when nothing could ever ask for the shell again", () => {
    const ws = fakeSocket();
    const session = makeSession("anonymous:1", { reattachable: false });
    attachSocket(session, ws);

    detachSocket(session, ws);

    // An older client, or a browser that could not store a key. Holding this
    // would be holding a `/bin/bash` against the container's PidsLimit for
    // half an hour, for a reconnect that cannot happen.
    expect(hangUpShell).toHaveBeenCalledTimes(1);
  });

  it("ignores a detach from a socket that has already been replaced", () => {
    const first = fakeSocket();
    const second = fakeSocket();
    const session = makeSession("u1:p1:k1");

    attachSocket(session, first);
    attachSocket(session, second);
    // The loser's close lands after the winner has taken over. Without this
    // guard it would detach the session its successor is now using.
    detachSocket(session, first);

    expect(session.ws).toBe(second);
    expect(session.detachedAt).toBeNull();
  });
});

describe("reattaching", () => {
  it("hands back what was printed while nobody was there", () => {
    const first = fakeSocket();
    const session = makeSession("u1:p1:k1");
    attachSocket(session, first);
    detachSocket(session, first);

    session.scrollback.write(Buffer.from("build finished"));

    const missed = attachSocket(session, fakeSocket());
    expect(missed?.toString()).toBe("build finished");
  });

  it("hands it back exactly once", () => {
    const session = makeSession("u1:p1:k1");
    session.scrollback.write(Buffer.from("output"));

    expect(attachSocket(session, fakeSocket())?.toString()).toBe("output");
    // A second reconnect must not replay a third copy of the same build.
    expect(attachSocket(session, fakeSocket())).toBeNull();
  });

  it("cancels the hangup that was waiting on it", () => {
    const ws = fakeSocket();
    const session = makeSession("u1:p1:k1");
    attachSocket(session, ws);
    detachSocket(session, ws);

    attachSocket(session, fakeSocket());
    vi.advanceTimersByTime(1800 * 1000);

    expect(hangUpShell).not.toHaveBeenCalled();
  });

  it("takes the terminal over rather than splitting it between two windows", () => {
    const first = fakeSocket();
    const session = makeSession("u1:p1:k1");
    attachSocket(session, first);

    attachSocket(session, fakeSocket());

    // One pty rendered into two windows is a terminal neither of them can
    // use, so the one that was there is closed and told why.
    expect(first.closeSpy).toHaveBeenCalledWith(
      4001,
      "This terminal was opened somewhere else",
    );
  });
});

describe("ending a session", () => {
  it("releases the container attachment exactly once", () => {
    const session = makeSession("u1:p1:k1");

    endSession(session, "grace-expired");
    endSession(session, "shell-exited");

    // Four things end a session and two can arrive together. Releasing twice
    // would decrement an attachment belonging to somebody else's socket.
    expect(session.release).toHaveBeenCalledTimes(1);
    expect(hangUpShell).toHaveBeenCalledTimes(1);
  });

  it("ends every session on a project when its container goes", () => {
    makeSession("u1:p1:k1");
    makeSession("u2:p1:k2");
    makeSession("u1:p2:k3", { projectId: "p2" });

    endProjectSessions("p1", "shutdown");

    expect(projectSessions("p1")).toHaveLength(0);
    expect(projectSessions("p2")).toHaveLength(1);
  });

  it("ends one person's sessions when their access is revoked", () => {
    makeSession("u1:p1:k1");
    makeSession("u1:p1:k2");
    // A collaborator who still has access, on the same project.
    makeSession("u2:p1:k3");

    endUserSessions("u1", "p1", "access-revoked");

    expect(findSession("u1:p1:k1")).toBeUndefined();
    expect(findSession("u1:p1:k2")).toBeUndefined();
    expect(findSession("u2:p1:k3")).toBeDefined();
  });
});

describe("the cap on sessions per project", () => {
  it("gives up the session nobody has been attached to for longest", () => {
    const older = makeSession("u1:p1:k1", { detachedAt: 1000 });
    const newer = makeSession("u1:p1:k2", { detachedAt: 2000 });
    makeSession("u1:p1:k3", { ws: fakeSocket() });

    expect(makeRoomForSession("p1")).toBe(true);

    expect(findSession(older.id)).toBeUndefined();
    expect(findSession(newer.id)).toBeDefined();
  });

  it("never gives up one somebody is looking at", () => {
    makeSession("u1:p1:k1", { ws: fakeSocket() });
    makeSession("u1:p1:k2", { ws: fakeSocket() });
    makeSession("u1:p1:k3", { ws: fakeSocket() });

    // Refused, so the reason can be shown, rather than closing a terminal
    // somebody is using to make room for one they just asked for.
    expect(makeRoomForSession("p1")).toBe(false);
    expect(projectSessions("p1")).toHaveLength(3);
  });

  it("is free when the project is under the cap", () => {
    makeSession("u1:p1:k1", { ws: fakeSocket() });

    expect(makeRoomForSession("p1")).toBe(true);
    expect(projectSessions("p1")).toHaveLength(1);
  });
});
