import { describe, expect, it } from "vitest";
import { MessageReader, encodeMessage } from "./framing.js";

const frame = (payload: string) => encodeMessage(payload);

describe("encodeMessage", () => {
  it("writes the length in bytes, not characters", () => {
    // "é" is two bytes in UTF-8; a character count would truncate the body.
    const encoded = encodeMessage('{"a":"é"}').toString("utf8");
    expect(encoded).toContain("Content-Length: 10\r\n\r\n");
  });
});

describe("MessageReader", () => {
  it("reads one whole message", () => {
    const reader = new MessageReader();
    expect(reader.push(frame('{"id":1}'))).toEqual(['{"id":1}']);
  });

  /** A chunk boundary can fall anywhere, and this is the case a naive reader
   *  gets wrong: it sees an incomplete header and throws the bytes away. */
  it("waits for a message split across chunks", () => {
    const reader = new MessageReader();
    const whole = frame('{"id":1}');

    expect(reader.push(whole.subarray(0, 8))).toEqual([]);
    expect(reader.push(whole.subarray(8))).toEqual(['{"id":1}']);
  });

  it("copes with a split inside the body", () => {
    const reader = new MessageReader();
    const whole = frame('{"id":1234}');
    const cut = whole.length - 3;

    expect(reader.push(whole.subarray(0, cut))).toEqual([]);
    expect(reader.push(whole.subarray(cut))).toEqual(['{"id":1234}']);
  });

  /** A server answering a burst writes messages back to back. Returning
   *  only the first is a hang rather than an error, which is worse. */
  it("returns every message a single chunk completed", () => {
    const reader = new MessageReader();
    const two = Buffer.concat([frame('{"id":1}'), frame('{"id":2}')]);
    expect(reader.push(two)).toEqual(['{"id":1}', '{"id":2}']);
  });

  it("carries a partial second message over to the next chunk", () => {
    const reader = new MessageReader();
    const second = frame('{"id":2}');
    const chunk = Buffer.concat([frame('{"id":1}'), second.subarray(0, 5)]);

    expect(reader.push(chunk)).toEqual(['{"id":1}']);
    expect(reader.push(second.subarray(5))).toEqual(['{"id":2}']);
  });

  it("reads the header case-insensitively, as the spec allows", () => {
    const reader = new MessageReader();
    const body = Buffer.from('{"id":1}');
    const chunk = Buffer.concat([
      Buffer.from(`content-length: ${String(body.length)}\r\n\r\n`),
      body,
    ]);
    expect(reader.push(chunk)).toEqual(['{"id":1}']);
  });

  it("tolerates extra headers", () => {
    const reader = new MessageReader();
    const body = Buffer.from('{"id":1}');
    const chunk = Buffer.concat([
      Buffer.from(
        `Content-Length: ${String(body.length)}\r\nContent-Type: application/vscode-jsonrpc\r\n\r\n`,
      ),
      body,
    ]);
    expect(reader.push(chunk)).toEqual(['{"id":1}']);
  });

  it("decodes multi-byte characters correctly", () => {
    const reader = new MessageReader();
    expect(reader.push(frame('{"a":"héllo"}'))).toEqual(['{"a":"héllo"}']);
  });

  /** Without the `continue`, a header with no length would leave the buffer
   *  unchanged and the loop would spin forever on it. */
  it("does not spin on a header with no length", () => {
    const reader = new MessageReader();
    const chunk = Buffer.concat([
      Buffer.from("X-Nonsense: 1\r\n\r\n"),
      frame('{"id":1}'),
    ]);
    expect(reader.push(chunk)).toEqual(['{"id":1}']);
  });

  it("reports what it is still holding", () => {
    const reader = new MessageReader();
    reader.push(frame('{"id":1}').subarray(0, 6));
    expect(reader.pending).toBe(6);
  });

  it("holds nothing once a message is complete", () => {
    const reader = new MessageReader();
    reader.push(frame('{"id":1}'));
    expect(reader.pending).toBe(0);
  });
});
