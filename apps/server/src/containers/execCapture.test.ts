import { describe, expect, it } from "vitest";
import { demux } from "./execCapture.js";

/** Builds one Docker multiplex frame: 1 byte stream id, 3 pad, 4-byte BE
 *  length, then the payload. */
function frame(streamId: number, payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(8);
  header[0] = streamId;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

describe("demux", () => {
  it("routes stdout (stream 1) and stderr (stream 2) apart", () => {
    const raw = Buffer.concat([frame(1, "out"), frame(2, "err")]);
    expect(demux(raw)).toEqual({ stdout: "out", stderr: "err" });
  });

  it("concatenates frames of the same stream in order", () => {
    const raw = Buffer.concat([frame(1, "a"), frame(1, "b"), frame(1, "c")]);
    expect(demux(raw)).toEqual({ stdout: "abc", stderr: "" });
  });

  it("keeps interleaved streams in their own channels", () => {
    const raw = Buffer.concat([
      frame(1, "1"),
      frame(2, "e1"),
      frame(1, "2"),
      frame(2, "e2"),
    ]);
    expect(demux(raw)).toEqual({ stdout: "12", stderr: "e1e2" });
  });

  it("returns empty strings for empty output", () => {
    expect(demux(Buffer.alloc(0))).toEqual({ stdout: "", stderr: "" });
  });

  it("handles stderr-only output (the case that used to hang)", () => {
    // git in a non-repo writes only to stderr; the stdout channel gets no
    // frame at all, which is exactly what the old collector waited on forever.
    const raw = frame(2, "fatal: not a git repository");
    expect(demux(raw)).toEqual({
      stdout: "",
      stderr: "fatal: not a git repository",
    });
  });

  it("takes a frame truncated by the output cap up to the buffer's end", () => {
    // Header claims 100 bytes but only 5 are present (output was capped
    // mid-frame); the parser must not read past the buffer.
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(100, 4);
    const raw = Buffer.concat([header, Buffer.from("short", "utf8")]);
    expect(demux(raw)).toEqual({ stdout: "short", stderr: "" });
  });

  it("preserves multibyte utf8 split across the payload", () => {
    const raw = frame(1, "café ☕ 日本語");
    expect(demux(raw)).toEqual({ stdout: "café ☕ 日本語", stderr: "" });
  });
});
