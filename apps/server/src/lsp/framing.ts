/** LSP's wire framing: `Content-Length: N\r\n\r\n` then N bytes of JSON.
 *
 *  This is the one real difference from the terminal gateway, which carries
 *  raw PTY bytes and never has to know where one message ends. A language
 *  server's stdout is a stream of framed messages, and a chunk boundary can
 *  fall anywhere — mid-header, mid-body, or between two complete messages —
 *  so the reader has to buffer rather than assume a chunk is a message.
 */
export class MessageReader {
  private buffer = Buffer.alloc(0);

  /** Feeds a chunk in, and returns whatever complete messages it completed.
   *
   *  Returns an array rather than one message because a single chunk can
   *  carry several — a server answering a burst of requests writes them back
   *  to back, and dropping all but the first is a hang rather than an error. */
  push(chunk: Buffer): string[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: string[] = [];

    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);

      if (!match?.[1]) {
        // A header with no length is unrecoverable: without it there is no
        // way to know where the body ends, so resynchronising is guesswork.
        // Dropping the header and continuing at least does not spin.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) break;

      messages.push(this.buffer.subarray(start, start + length).toString("utf8"));
      this.buffer = this.buffer.subarray(start + length);
    }

    return messages;
  }

  /** Bytes held waiting for the rest of a message. For a size guard: a
   *  server that never completes a message would otherwise grow this
   *  forever. */
  get pending(): number {
    return this.buffer.length;
  }
}

/** Frames a message for sending to a server. */
export function encodeMessage(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${String(body.length)}\r\n\r\n`, "ascii"),
    body,
  ]);
}
