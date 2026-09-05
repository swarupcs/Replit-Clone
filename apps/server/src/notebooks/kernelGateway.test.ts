import { describe, expect, it, vi } from "vitest";

/** The exec that starts a kernel, and the line framing around it. plan.md
 *  §12.3.
 *
 *  A gateway test rather than a policy one, for the reason
 *  `lspGateway.test.ts` gives about its own: the mistakes that live here are
 *  not decisions about whether to start something, but about how — and the
 *  one that file records (a working directory that existed in no image, so no
 *  language server had ever run) is available to be made again here.
 */

/** Deliberately NOT the real mount point.
 *
 *  A mock echoing "/home/sandbox/app" would let a hardcoded literal pass a
 *  test named "starts where the project is mounted", which is exactly the
 *  assertion that has to fail for the test to be worth having.
 *
 *  Repeated inside the mock below rather than referenced, because `vi.mock` is
 *  hoisted above every declaration in the file. */
const MOUNTED_AT = "/mounted/somewhere-else";

vi.mock("../containers/containerManager.js", () => ({
  MOUNT_POINT: "/mounted/somewhere-else",
  ensureContainer: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
}));
vi.mock("../service/tokenService.js", () => ({ verifyAccessToken: vi.fn() }));
vi.mock("../service/projectAccessService.js", () => ({
  assertProjectAccess: vi.fn(),
}));

const { kernelExec, LineReader } = await import("./kernelGateway.js");
const { MOUNT_POINT } = await import("../containers/containerManager.js");

describe("where a kernel is started", () => {
  /** Sharper here than for a language server. A notebook's whole working
   *  idiom is relative paths — `pd.read_csv("sales.csv")` next to the
   *  notebook — so a kernel started in the wrong directory does not fail to
   *  start. It starts, and then every file the user can SEE in the tree is
   *  "no such file or directory". */
  it("runs where the project is mounted, wherever that is", () => {
    expect(kernelExec(["rc-kernel"]).WorkingDir).toBe(MOUNTED_AT);
    expect(kernelExec(["rc-kernel"]).WorkingDir).toBe(MOUNT_POINT);
  });

  /** With a TTY, Docker merges stdout and stderr into one stream. Any warning
   *  a dependency prints on import would then land in the middle of the JSON
   *  the renderer is parsing — a corrupted protocol rather than a visible
   *  failure. */
  it("asks for no TTY", () => {
    expect(kernelExec(["rc-kernel"]).Tty).toBe(false);
  });

  it("attaches all three streams", () => {
    // stdin carries executes, stdout carries the protocol, and stderr is what
    // makes the driver's own complaints readable instead of protocol noise.
    expect(kernelExec(["rc-kernel"])).toMatchObject({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    });
  });
});

describe("the line framing", () => {
  /** The mistake this class exists to prevent. A chunk boundary is not a
   *  message boundary, and a notebook makes that certain rather than likely:
   *  a `display_data` carrying a matplotlib PNG is hundreds of kilobytes of
   *  base64 on ONE line, which cannot arrive in one chunk. */
  it("holds a line that arrives in pieces", () => {
    const reader = new LineReader();

    expect(reader.push(Buffer.from('{"type":"sta'))).toEqual([]);
    expect(reader.push(Buffer.from('tus","state":"busy"}\n'))).toEqual([
      '{"type":"status","state":"busy"}',
    ]);
  });

  it("returns every complete line in one chunk, in order", () => {
    const reader = new LineReader();

    expect(reader.push(Buffer.from("one\ntwo\nthree\n"))).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  /** A chunk ending mid-line must not emit the tail, and must not lose it. */
  it("keeps a partial tail back and counts it as pending", () => {
    const reader = new LineReader();

    expect(reader.push(Buffer.from("done\npart"))).toEqual(["done"]);
    expect(reader.pending).toBe(4);
    expect(reader.push(Buffer.from("ial\n"))).toEqual(["partial"]);
    expect(reader.pending).toBe(0);
  });

  /** Multi-byte UTF-8 is routine here: a traceback is full of box-drawing
   *  characters and ANSI escapes, and `str` output is whatever the user
   *  printed. */
  it("survives a multi-byte character split across chunks", () => {
    const reader = new LineReader();
    const line = Buffer.from('{"emoji":"🧪"}\n');

    // Split inside the four bytes of the emoji.
    expect(reader.push(line.subarray(0, 12))).toEqual([]);
    expect(reader.push(line.subarray(12))).toEqual(['{"emoji":"🧪"}']);
  });

  it("ignores blank lines rather than emitting empty messages", () => {
    const reader = new LineReader();

    expect(reader.push(Buffer.from("\n\nreal\n\n"))).toEqual(["real"]);
  });
});
