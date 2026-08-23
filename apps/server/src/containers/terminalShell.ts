import type { Container } from "dockerode";
import { logger } from "../lib/logger.js";

/** Ending a shell that the browser has stopped listening to.
 *
 *  Closing the hijacked stream does NOT end the exec. Measured against a real
 *  container: attach a `/bin/bash` exec, `stream.end()` and `stream.destroy()`,
 *  and a second later the shell is still there and `exec.inspect().Running` is
 *  still true. Docker holds the pty open; nothing tells the shell its terminal
 *  went away.
 *
 *  So every closed terminal left a `/bin/bash` inside the project's container,
 *  and they accumulated for as long as the container lived — a reconnect after
 *  a network blip, a token rotation, a closed panel, and (in development) every
 *  StrictMode double-mount each added one.
 *
 *  The fix is to do by hand what a real hangup does: the shell records its own
 *  pid on the way in, and when the socket goes we send SIGHUP to its process
 *  group. A `docker exec -t` process is its own session leader, so its pid is
 *  its process group id, and the group is everything the shell started. That
 *  is the correct scope: hanging up a terminal takes the shell's jobs with it,
 *  exactly as closing a real one does.
 */

/** Where a terminal's shell records its pid. One file per terminal, because a
 *  project can have more than one open at a time. */
export function terminalPidFile(terminalId: number): string {
  return `/tmp/rc-term-${String(terminalId)}.pid`;
}

/** The shell, wrapped just enough to record its own pid.
 *
 *  `exec` replaces the wrapper rather than spawning under it, so the pid the
 *  file holds is the shell's own, and the user still gets a plain interactive
 *  bash — no login shell in between, which would have changed the environment
 *  the terminal has always had.
 */
export function shellArgv(pidFile: string): string[] {
  return ["/bin/bash", "-c", `echo $$ > ${pidFile}; exec /bin/bash`];
}

/** The script that hangs a shell up. Exported for the test to read. */
export function hangUpScript(pidFile: string): string {
  return (
    `p=$(cat ${pidFile} 2>/dev/null || true); rm -f ${pidFile}; ` +
    // A pid that is already gone leaves an empty file behind, and `kill -HUP -`
    // with no argument would be an error rather than a no-op.
    `if [ -n "$p" ]; then ` +
    `kill -HUP -"$p" 2>/dev/null || true; ` +
    // A backstop for anything that ignores a hangup. Nobody is waiting on this
    // exec, so the delay costs nothing.
    `sleep 3; kill -KILL -"$p" 2>/dev/null || true; fi`
  );
}

/** Hangs up the shell this terminal started, if it is still running.
 *
 *  Fire-and-forget: the caller is a socket that has already gone, so there is
 *  nobody to report to and nothing to wait for. Failures are logged and
 *  swallowed — a container that has already stopped has no shell to end.
 */
export async function hangUpShell(
  container: Container,
  pidFile: string,
): Promise<void> {
  try {
    const exec = await container.exec({
      Cmd: ["/bin/sh", "-c", hangUpScript(pidFile)],
      AttachStdout: false,
      AttachStderr: false,
    });

    const stream = await exec.start({ hijack: false, stdin: false });
    stream.destroy();
  } catch (error) {
    logger.warn("could not hang up a terminal shell", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
