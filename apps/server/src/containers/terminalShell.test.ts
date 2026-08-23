import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { hangUpScript, shellArgv, terminalPidFile } from "./terminalShell.js";

describe("terminalPidFile", () => {
  /** A project can have more than one terminal open, and two shells sharing a
   *  pid file would mean closing either one hangs up the other. */
  it("gives each terminal a file of its own", () => {
    expect(terminalPidFile(1)).not.toBe(terminalPidFile(2));
  });
});

describe("shellArgv", () => {
  it("records the shell's pid before handing over", () => {
    expect(shellArgv("/tmp/x.pid").join(" ")).toContain("echo $$ > /tmp/x.pid");
  });

  /** `exec` replaces the wrapper rather than spawning under it, so the pid in
   *  the file is the shell's own — a wrapper that stayed would leave the file
   *  naming a process that is not the one to hang up. */
  it("replaces the wrapper with the shell rather than nesting one inside it", () => {
    expect(shellArgv("/tmp/x.pid").join(" ")).toContain("exec /bin/bash");
  });

  /** The terminal has always given users a plain interactive bash. A login
   *  shell here would quietly change the environment they work in. */
  it("does not turn the shell into a login shell", () => {
    expect(shellArgv("/tmp/x.pid")).not.toContain("-lc");
  });
});

describe("hangUpScript", () => {
  /** A `docker exec -t` process is its own session leader, so its pid is its
   *  process group id — and the group is everything the shell started. That is
   *  the right scope: hanging up a terminal takes its jobs with it, exactly as
   *  closing a real one does. */
  it("signals the shell's whole process group", () => {
    expect(hangUpScript("/tmp/x.pid")).toContain('kill -HUP -"$p"');
  });

  it("follows up with a kill for anything that ignores a hangup", () => {
    expect(hangUpScript("/tmp/x.pid")).toContain('kill -KILL -"$p"');
  });

  /** A shell that already exited leaves an empty file behind, and `kill -HUP -`
   *  with no pid is an error rather than a no-op. */
  it("does nothing when there is no pid recorded", () => {
    expect(hangUpScript("/tmp/x.pid")).toContain('if [ -n "$p" ]');
  });

  /** Left behind, a stale file would name a pid the container is free to reuse
   *  — and the next hangup would signal whatever now holds it. */
  it("removes the pid file", () => {
    expect(hangUpScript("/tmp/x.pid")).toContain("rm -f /tmp/x.pid");
  });
});
