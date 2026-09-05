import { randomBytes } from "node:crypto";
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
 *
 *  That covers the shells this server hangs up itself. It does not cover the
 *  ones it never gets the chance to — see `reclaimScript`.
 */

/** Where a terminal's shell records its pid.
 *
 *  The nonce is what makes this safe. The file used to be named for the
 *  terminal id alone, and a terminal id is REUSED: reconnect shell 1 and the
 *  new shell wrote its pid over the old shell's, which was then the only
 *  record of a process still holding the container's ports. It could no longer
 *  be hung up by anything, and it survived until the container did.
 *
 *  One file per shell instead. Nothing overwrites anything, so every shell
 *  stays reachable by the socket that started it, and the id still groups them
 *  for `reclaimScript` to sweep.
 */
export function terminalPidFile(terminalId: number, nonce: string): string {
  return `/tmp/rc-term-${String(terminalId)}-${nonce}.pid`;
}

/** A name for one shell's pid file. Not a secret — just distinct. */
export function shellNonce(): string {
  return randomBytes(6).toString("hex");
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

/** Hangs up every OTHER shell this terminal has left behind.
 *
 *  A hangup only happens if this server is alive to send it, and there are
 *  ways for it not to be: it is restarted, it crashes, the socket's close is
 *  never delivered. The shell survives all three, and so does everything it
 *  started — which is how a project ends up with a dev server nobody can see
 *  holding port 3000, and `npm start` answering EADDRINUSE in a terminal that
 *  looks empty. The user's only recourse was to delete the container.
 *
 *  Opening a terminal is the moment to collect them: the id is about to have a
 *  live shell again, and every earlier shell under that id is unreachable
 *  garbage — a reconnected terminal is a fresh bash with no scrollback, so
 *  there was never a way back to the old one. Taking its jobs with it is the
 *  same bargain as closing the terminal in the first place. Anything meant to
 *  outlive a terminal belongs to the Run button, which tracks its own process
 *  group and is not swept.
 *
 *  `keep` is this shell's own file, excluded by exact name. That is what makes
 *  the sweep safe to fire and forget: it cannot matter whether it runs before
 *  or after the new shell writes its pid, because the one file that must
 *  survive is named and skipped either way.
 */
export function reclaimScript(terminalId: number, keep: string): string {
  return (
    `for f in /tmp/rc-term-${String(terminalId)}-*.pid; do ` +
    `[ -f "$f" ] || continue; ` +
    `[ "$f" = "${keep}" ] && continue; ` +
    `p=$(cat "$f" 2>/dev/null || true); rm -f "$f"; ` +
    `if [ -n "$p" ]; then kill -HUP -"$p" 2>/dev/null || true; fi; ` +
    `done`
  );
}

/** Runs a script in the container with nobody attached to it.
 *
 *  Fire-and-forget: the caller is either a socket that has already gone or a
 *  terminal that must not be kept waiting, so there is nobody to report to and
 *  nothing to wait for. Failures are logged and swallowed — a container that
 *  has already stopped has no shell to end.
 */
async function detached(
  container: Container,
  script: string,
  what: string,
): Promise<void> {
  try {
    const exec = await container.exec({
      Cmd: ["/bin/sh", "-c", script],
      AttachStdout: false,
      AttachStderr: false,
    });

    const stream = await exec.start({ hijack: false, stdin: false });
    stream.destroy();
  } catch (error) {
    logger.warn(what, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Hangs up the shell this terminal started, if it is still running. */
export async function hangUpShell(
  container: Container,
  pidFile: string,
): Promise<void> {
  await detached(
    container,
    hangUpScript(pidFile),
    "could not hang up a terminal shell",
  );
}

/** Hangs up shells left over from earlier connections to this terminal id. */
export async function reclaimShells(
  container: Container,
  terminalId: number,
  keep: string,
): Promise<void> {
  await detached(
    container,
    reclaimScript(terminalId, keep),
    "could not reclaim orphaned terminal shells",
  );
}
