import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  hangUpScript,
  reclaimScript,
  shellArgv,
  shellNonce,
  terminalPidFile,
} from "./terminalShell.js";

describe("terminalPidFile", () => {
  /** A project can have more than one terminal open, and two shells sharing a
   *  pid file would mean closing either one hangs up the other. */
  it("gives each terminal a file of its own", () => {
    expect(terminalPidFile(1, "a")).not.toBe(terminalPidFile(2, "a"));
  });

  /** The defect the nonce is for. Terminal ids are reused, so naming the file
   *  after the id alone meant a reconnecting shell wrote its pid over the pid
   *  of a shell that was still running — and that file was the only handle on
   *  it. Whatever it had started, a dev server holding port 3000 most often,
   *  stayed until the container was deleted. */
  it("gives each shell on one terminal a file of its own", () => {
    expect(terminalPidFile(1, "a")).not.toBe(terminalPidFile(1, "b"));
  });

  /** `reclaimScript` globs on the id, so the id has to survive the nonce
   *  being appended. */
  it("keeps the terminal's id findable in the name", () => {
    expect(terminalPidFile(4, shellNonce())).toContain("/tmp/rc-term-4-");
  });

  it("does not repeat a nonce", () => {
    const seen = new Set(Array.from({ length: 200 }, () => shellNonce()));

    expect(seen.size).toBe(200);
  });
});

describe("reclaimScript", () => {
  /** Every shell recorded under this terminal's id, whatever nonce it got. */
  it("looks at every pid file for the terminal", () => {
    expect(reclaimScript(4, "/tmp/rc-term-4-keep.pid")).toContain(
      "/tmp/rc-term-4-*.pid",
    );
  });

  /** The sweep is fired without being awaited, so it can run before or after
   *  the new shell records itself. Skipping the new file by exact name is what
   *  makes both orders safe — a sweep that could match it would hang up the
   *  very terminal it was opening. */
  it("skips the shell being opened", () => {
    expect(reclaimScript(4, "/tmp/rc-term-4-keep.pid")).toContain(
      '[ "$f" = "/tmp/rc-term-4-keep.pid" ] && continue',
    );
  });

  /** The group, not the pid: a shell's jobs are what actually hold the ports,
   *  and hanging up a terminal has always taken its jobs with it. */
  it("signals the whole process group", () => {
    expect(reclaimScript(4, "/tmp/x.pid")).toContain('kill -HUP -"$p"');
  });

  /** A stale file whose process is long gone would otherwise be swept on every
   *  reconnect for the life of the container. */
  it("removes each file it has read", () => {
    expect(reclaimScript(4, "/tmp/x.pid")).toContain('rm -f "$f"');
  });

  /** An empty file — a shell killed between creating it and writing to it —
   *  would make `kill -HUP -` an error rather than a no-op, and the glob
   *  matching nothing leaves the pattern itself as `$f`. */
  it("acts on nothing it cannot read a pid from", () => {
    const script = reclaimScript(4, "/tmp/x.pid");

    expect(script).toContain('[ -f "$f" ] || continue');
    expect(script).toContain('if [ -n "$p" ]');
  });

  /** Deliberately no `sleep 3; kill -KILL` backstop, unlike `hangUpScript`.
   *  This one runs while a user is waiting for a terminal to open, and a
   *  SIGKILL denies a dev server the chance to release its port cleanly — the
   *  next connection sweeps again if a hangup was ignored. */
  it("does not escalate to SIGKILL", () => {
    expect(reclaimScript(4, "/tmp/x.pid")).not.toContain("kill -KILL");
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
