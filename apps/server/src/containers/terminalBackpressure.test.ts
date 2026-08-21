import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { forwardOutput } from "./handleTerminalCreation.js";

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

    forwardOutput(stream, ws);
    stream.write(chunk(1024));

    expect(sent).toHaveLength(1);
    expect(stream.isPaused()).toBe(false);
  });

  it("sends nothing to a socket that is not open", () => {
    const stream = new PassThrough();
    const { ws, sent, raw } = fakeSocket();
    raw.readyState = 3;

    forwardOutput(stream, ws);
    stream.write(chunk(1024));

    expect(sent).toEqual([]);
  });

  it("stops reading from the container once the client falls behind", () => {
    // The defect: this used to send unconditionally, so a process writing
    // faster than the client drains grew the queue in the server's memory
    // until the process died.
    const stream = new PassThrough();
    const { ws, raw } = fakeSocket();

    forwardOutput(stream, ws);

    raw.bufferedAmount = 8 * 1024 * 1024;
    stream.write(chunk(1024));

    expect(stream.isPaused()).toBe(true);
  });

  it("starts reading again once the client has caught up", () => {
    const stream = new PassThrough();
    const { ws, raw } = fakeSocket();

    forwardOutput(stream, ws);

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

    forwardOutput(stream, ws);

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

    forwardOutput(stream, ws);
    raw.bufferedAmount = 32 * 1024 * 1024;

    for (let i = 0; i < 50; i += 1) stream.write(chunk(64));

    expect(sent).toHaveLength(1);
  });

  it("gives up waiting for a socket that closed while behind", () => {
    const stream = new PassThrough();
    const { ws, raw } = fakeSocket();

    forwardOutput(stream, ws);
    raw.bufferedAmount = 8 * 1024 * 1024;
    stream.write(chunk(1024));

    raw.readyState = 3;
    vi.advanceTimersByTime(200);

    // Left paused rather than spinning a timer forever over a dead socket.
    expect(stream.isPaused()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
