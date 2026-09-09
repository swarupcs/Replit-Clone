import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { forwardOutput } from "./handleTerminalCreation.js";
import { Scrollback } from "../terminal/terminalSessions.js";
import type { TerminalSession } from "../terminal/terminalSessions.js";

/** A socket that queues rather than sending, so `bufferedAmount` can be driven
 *  the way a slow client drives it. */
function fakeSocket() {
  const sent: (string | Buffer)[] = [];

  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send(payload: string | Buffer) {
      sent.push(payload);
    },
  };

  return { ws: ws as unknown as WebSocket, sent, raw: ws };
}

/** Enough of a session for `forwardOutput`, which only ever reads `ws`,
 *  `scrollback` and `ended`. */
function fakeSession(ws: WebSocket | null, scrollbackBytes = 64 * 1024) {
  return {
    ws,
    scrollback: new Scrollback(scrollbackBytes),
    ended: false,
  } as unknown as TerminalSession;
}

const chunk = (bytes: number) => Buffer.alloc(bytes, 0x61);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("terminal output backpressure", () => {
  it("forwards output while the client is keeping up", () => {
    const stream = new PassThrough();
    const { ws, sent } = fakeSocket();

    forwardOutput(stream, fakeSession(ws));
    stream.write(chunk(1024));

    expect(sent).toHaveLength(1);
    expect(stream.isPaused()).toBe(false);
  });

  it("stops reading from the container once the client falls behind", () => {
    // The defect: this used to send unconditionally, so a process writing
    // faster than the client drains grew the queue in the server's memory
    // until the process died.
    const stream = new PassThrough();
    const { ws, raw } = fakeSocket();

    forwardOutput(stream, fakeSession(ws));

    raw.bufferedAmount = 8 * 1024 * 1024;
    stream.write(chunk(1024));

    expect(stream.isPaused()).toBe(true);
  });

  it("starts reading again once the client has caught up", () => {
    const stream = new PassThrough();
    const { ws, raw } = fakeSocket();

    forwardOutput(stream, fakeSession(ws));

    raw.bufferedAmount = 8 * 1024 * 1024;
    stream.write(chunk(1024));
    expect(stream.isPaused()).toBe(true);

    raw.bufferedAmount = 0;
    vi.advanceTimersByTime(60);

    expect(stream.isPaused()).toBe(false);
  });

  it("drops output rather than buffering it without limit", () => {
    const stream = new PassThrough();
    const { ws, sent, raw } = fakeSocket();

    forwardOutput(stream, fakeSession(ws));

    // Far beyond anything a reader could be behind by honestly.
    raw.bufferedAmount = 32 * 1024 * 1024;
    stream.write(chunk(1024));
    stream.write(chunk(1024));
    stream.write(chunk(1024));

    // One notice, and none of the payload.
    expect(sent).toHaveLength(1);
    expect(String(sent[0])).toContain("dropped");
  });

  it("says it dropped output once, not once per chunk", () => {
    const stream = new PassThrough();
    const { ws, sent, raw } = fakeSocket();

    forwardOutput(stream, fakeSession(ws));
    raw.bufferedAmount = 32 * 1024 * 1024;

    for (let i = 0; i < 50; i += 1) stream.write(chunk(64));

    expect(sent).toHaveLength(1);
  });
});

/** plan.md §13.7. Two of these replace tests that asserted the opposite, and
 *  both were right about the product they were written for: with the shell
 *  ending when the socket did, output arriving after a close had nowhere to go
 *  and no reader to go to. A detached session has both. */
describe("output while nobody is attached", () => {
  it("keeps output for the client that left rather than discarding it", () => {
    const stream = new PassThrough();
    const session = fakeSession(null);

    forwardOutput(stream, session);
    stream.write(chunk(1024));

    // The replay on reattach is the half of §13.7 anybody sees. Discarding
    // here would reconnect somebody to a live pty and a blank pane, with no
    // way to know whether their build finished.
    expect(session.scrollback.size).toBe(1024);
  });

  it("sends nothing to a socket that is not open, and keeps it instead", () => {
    const stream = new PassThrough();
    const { ws, sent, raw } = fakeSocket();
    raw.readyState = 3;
    const session = fakeSession(ws);

    forwardOutput(stream, session);
    stream.write(chunk(1024));

    expect(sent).toEqual([]);
    expect(session.scrollback.size).toBe(1024);
  });

  it("drops the oldest output rather than growing without limit", () => {
    const stream = new PassThrough();
    const session = fakeSession(null, 4096);

    forwardOutput(stream, session);
    for (let i = 0; i < 20; i += 1) stream.write(chunk(1024));

    // A detached client applies no backpressure, so this cap is the only thing
    // between a `yes` loop and the server's heap.
    expect(session.scrollback.size).toBeLessThanOrEqual(4096);
  });

  it("lets the container keep running when a client leaves while behind", () => {
    // This replaces "gives up waiting for a socket that closed while behind",
    // which asserted the stream was left PAUSED. That was correct when the
    // shell was about to be hung up anyway. It is now exactly wrong: a paused
    // stream blocks the exec's writes, which stops the build the user
    // detached in order to keep running.
    const stream = new PassThrough();
    const { ws, raw } = fakeSocket();
    const session = fakeSession(ws);

    forwardOutput(stream, session);
    raw.bufferedAmount = 8 * 1024 * 1024;
    stream.write(chunk(1024));
    expect(stream.isPaused()).toBe(true);

    raw.readyState = 3;
    vi.advanceTimersByTime(200);

    expect(stream.isPaused()).toBe(false);
    // And no timer left spinning over a socket that has gone.
    expect(vi.getTimerCount()).toBe(0);
  });
});
