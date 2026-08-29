import { describe, expect, it, vi } from "vitest";

/** The exec that starts a language server.
 *
 *  A gateway test rather than a policy one, because the bug this pins down was
 *  not a decision about whether to start a server -- the policy said yes every
 *  time -- but about how. The exec asked for a working directory that does not
 *  exist, so Docker refused to start the process and no language server had
 *  ever run. Six months of "Python intelligence" behind a flag nobody turned
 *  on, and the first person to turn it on would have got silence.
 */

/** Deliberately NOT the real mount point.
 *
 *  A mock echoing "/home/sandbox/app" would let a hardcoded literal in the
 *  gateway pass a test named "takes it from the mount point" -- which is
 *  exactly the assertion that has to fail for the test to be worth having. A
 *  sentinel makes the two distinguishable: only code that reads the constant
 *  can produce this value.
 *
 *  Repeated inside the mock below rather than referenced, because `vi.mock` is
 *  hoisted above every declaration in the file. */
const MOUNTED_AT = "/mounted/somewhere-else";

// The gateway pulls in the whole container manager, its Docker client and the
// env schema at import time. None of that is what is under test here.
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

const { languageServerExec } = await import("./lspGateway.js");
const { MOUNT_POINT } = await import("../containers/containerManager.js");

describe("where a language server is started", () => {
  it("runs where the project is mounted, wherever that is", () => {
    // The defect: this said "/app", which exists in none of the sandbox
    // images. Docker does not create a missing working directory -- it
    // refuses to start the process at all:
    //   chdir to cwd ("/app") failed: no such file or directory
    // Found and confirmed against a real container.
    //
    // Asserted against the mocked mount point rather than against the real
    // string, so a literal reintroduced here fails even if somebody copies
    // today's correct value. Moving the mount must move the server with it.
    expect(languageServerExec(["pylsp"]).WorkingDir).toBe(MOUNTED_AT);
    expect(languageServerExec(["pylsp"]).WorkingDir).toBe(MOUNT_POINT);
  });

  it("asks for no TTY", () => {
    // With a TTY, Docker merges stdout and stderr into one stream and the
    // server's own logging is spliced into the JSON-RPC it is meant to be
    // speaking. That is a corrupted protocol, not a visible failure.
    expect(languageServerExec(["pylsp"]).Tty).toBe(false);
  });

  it("attaches all three streams", () => {
    // stdin carries requests, stdout carries the protocol, and stderr is what
    // makes a server's own complaints readable instead of protocol noise.
    expect(languageServerExec(["gopls", "serve"])).toMatchObject({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    });
  });

  it("runs the argv it was given, whole", () => {
    // `gopls serve` is two words. An implementation that took only the binary
    // would start gopls in its default mode, which is not a language server.
    expect(languageServerExec(["gopls", "serve"]).Cmd).toEqual([
      "gopls",
      "serve",
    ]);
  });
});
