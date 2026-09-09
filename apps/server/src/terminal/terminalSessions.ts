import type { Container, Exec } from "dockerode";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import { hangUpShell } from "../containers/terminalShell.js";

/** A shell that belongs to a session rather than to a socket. plan.md §13.7.
 *
 *  **What was wrong.** `handleTerminalCreation` registered its teardown on
 *  `ws.on("close")`, and that teardown sends SIGHUP to the shell's process
 *  group. So the WebSocket closing ended the shell and everything it had
 *  started: closing a laptop, a train tunnel, a tab the OS discarded, or
 *  fifteen seconds of bad wifi killed a running `npm run build`, a migration
 *  or a test run, with no record of it and nothing to come back to.
 *
 *  **Why the code was like that, and why none of it may be reverted.** The
 *  hangup is not incidental — it closes a real leak, found on 2026-09-04 by
 *  looking at a running container. Docker keeps the pty open when the stream
 *  goes, so without it every closed terminal left a `/bin/bash` behind: a dev
 *  server holding port 3000 that nothing could see, and zombies accumulating
 *  against a `PidsLimit` of 256. `terminalShell.ts` documents all of it. The
 *  bug is not that the shell is hung up. It is *when*.
 *
 *  **What this changes.** A disconnect **detaches**; only a timer hangs up.
 *  The exec, its stream and its pid file outlive the socket inside a session
 *  the client can name, and a reconnect within the grace window re-binds to
 *  the same pty and is handed back everything printed while it was away. When
 *  the window expires with nobody attached, the session ends exactly as a
 *  close ended it before — the same `hangUpShell`, on the same pid file. The
 *  leak stays closed; it is closed half an hour later instead of instantly.
 *
 *  **The symmetry this restores.** §11.7 already decided this question for the
 *  editor: a dropped connection is an ordinary event and not a decision by the
 *  user, so unsaved edits are kept and offered back. Two correct decisions had
 *  composed into a product where your text survived the tunnel and your build
 *  did not.
 */

/** How a session ended, for the log line and for the client's close reason. */
export type SessionEndReason =
  | "grace-expired"
  | "shell-exited"
  | "access-revoked"
  | "client-ended"
  | "evicted"
  | "shutdown";

/** Client-supplied session keys name a session across a reconnect, so they are
 *  attacker-controlled input to a map key. Bounded and alphabet-restricted:
 *  the id ends up in log lines, and an unbounded one is a way to spend this
 *  server's memory a byte at a time.
 *
 *  It never reaches a shell. The pid file keeps the server-generated nonce it
 *  has always had (`terminalPidFile`), because that string IS interpolated
 *  into `hangUpScript` and `reclaimScript` — a client-named pid file would be
 *  shell injection into a script that runs `kill`.
 */
const CLIENT_KEY = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidClientKey(key: string): boolean {
  return CLIENT_KEY.test(key);
}

/** Scopes a session to one person on one project.
 *
 *  The user id is in the key rather than checked against the session
 *  afterwards, so there is no path where a valid client key reaches somebody
 *  else's shell: a mismatched user does not fail a comparison, it simply looks
 *  up nothing and gets a new session of their own. The project id is in it for
 *  the same reason.
 */
export function sessionId(
  userId: string,
  projectId: string,
  clientKey: string,
): string {
  return `${userId}:${projectId}:${clientKey}`;
}

/** Terminal output held for a client that is not currently attached.
 *
 *  Bounded by bytes, oldest dropped first — which is what scrollback means,
 *  and what stops a `yes` loop in a detached session from being a way to spend
 *  the server's heap. The client has no backpressure to apply while it is
 *  away, so this cap is the only thing between an unread session and memory.
 */
export class Scrollback {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly limit: number) {}

  write(chunk: Buffer): void {
    // A single chunk larger than the whole budget is kept as its tail rather
    // than dropped: the end of a build's output is the half worth having.
    const kept =
      chunk.length > this.limit ? chunk.subarray(chunk.length - this.limit) : chunk;

    this.chunks.push(kept);
    this.bytes += kept.length;

    while (this.bytes > this.limit && this.chunks.length > 0) {
      const dropped = this.chunks.shift();
      if (!dropped) break;
      this.bytes -= dropped.length;
    }
  }

  /** Everything held, as one buffer, or null when there is nothing. */
  read(): Buffer | null {
    if (this.chunks.length === 0) return null;
    return Buffer.concat(this.chunks, this.bytes);
  }

  clear(): void {
    this.chunks = [];
    this.bytes = 0;
  }

  get size(): number {
    return this.bytes;
  }
}

export interface TerminalSession {
  readonly id: string;
  readonly projectId: string;
  /** Distinguishes this terminal in the access watch and names its pid file.
   *  Stable for the life of the session, across any number of sockets. */
  readonly terminalId: number;
  readonly pidFile: string;
  readonly container: Container;
  readonly exec: Exec;
  readonly stream: Duplex;
  /** The socket currently rendering this shell, or null while detached. */
  ws: WebSocket | null;
  readonly scrollback: Scrollback;
  /** The last size any client asked for, re-applied when one reattaches: a
   *  reconnect from a different window must not leave the pty believing it is
   *  the size of the window that left. */
  size?: { w: number; h: number };
  /** Whether the exec is warm enough for a resize to take effect. */
  settled: boolean;
  /** When the last socket went, or null while one is attached. */
  detachedAt: number | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  /** Releases this session's hold on the project's container. */
  readonly release: () => void;
  /** Whether anybody could come back to this shell.
   *
   *  False for a client that named no session — an older build of the web app,
   *  or a browser that could not store a key. Such a shell is registered
   *  nowhere and reachable by nothing, so holding it through a grace window
   *  would be holding it for a reconnect that cannot happen: a `/bin/bash`
   *  against the container's `PidsLimit` for half an hour, for nobody. Those
   *  are hung up the instant their socket goes, exactly as every shell was
   *  before §13.7.
   */
  readonly reattachable: boolean;
  ended: boolean;
}

const sessions = new Map<string, TerminalSession>();

export function findSession(id: string): TerminalSession | undefined {
  return sessions.get(id);
}

/** Sessions this project currently holds, attached or not. */
export function projectSessions(projectId: string): TerminalSession[] {
  return [...sessions.values()].filter(
    (session) => session.projectId === projectId,
  );
}

export function sessionCount(): number {
  return sessions.size;
}

export function registerSession(session: TerminalSession): void {
  sessions.set(session.id, session);
}

/** Makes room for one more session on a project, or reports that there is none.
 *
 *  A session outliving its socket means a client can accumulate them, and each
 *  one is a `/bin/bash` against the container's `PidsLimit` plus a scrollback
 *  budget on this side. The cap is per project because that is where the pid
 *  limit is.
 *
 *  Detached sessions are given up first and oldest-first, which is the right
 *  order: a session nobody has been attached to for longest is the one least
 *  likely to be come back to. An attached session is never evicted — somebody
 *  is looking at it.
 */
export function makeRoomForSession(projectId: string): boolean {
  const cap = env.TERMINAL_MAX_SESSIONS_PER_PROJECT;

  // Bounded rather than `for(;;)`: every iteration is meant to remove one
  // session, and a loop whose exit depends on that being true is a hang in a
  // request path if it ever stops being true. One pass per session that
  // exists is more than enough to reach the cap.
  for (let guard = 0; guard <= cap; guard += 1) {
    const live = projectSessions(projectId);
    if (live.length < cap) return true;

    const detached = live
      .filter((session) => session.detachedAt !== null)
      .sort((a, b) => (a.detachedAt ?? 0) - (b.detachedAt ?? 0));

    const oldest = detached[0];
    if (!oldest) return false;

    endSession(oldest, "evicted");
  }

  return false;
}

/** Binds a socket to a session and hands back what it missed.
 *
 *  Returns the scrollback held while nobody was attached, which the caller
 *  writes to the client before anything else. That replay is the half of this
 *  feature a user actually sees: reattaching to a live pty with a blank pane
 *  and no idea whether the build finished would be barely better than a fresh
 *  shell.
 */
export function attachSocket(
  session: TerminalSession,
  ws: WebSocket,
): Buffer | null {
  if (session.graceTimer) {
    clearTimeout(session.graceTimer);
    session.graceTimer = null;
  }

  // A second window opening the same session takes it over rather than
  // splitting the pty's output between two renderers, which is a terminal
  // neither of them can use. The one that was there is told why.
  const previous = session.ws;
  if (previous && previous !== ws) {
    session.ws = null;
    try {
      previous.close(4001, "This terminal was opened somewhere else");
    } catch {
      // Already gone; nothing to tell.
    }
  }

  session.ws = ws;
  session.detachedAt = null;

  const missed = session.scrollback.read();
  session.scrollback.clear();
  return missed;
}

/** Lets go of the socket and starts the clock, rather than ending the shell. */
export function detachSocket(session: TerminalSession, ws: WebSocket): void {
  // A socket that was already replaced by `attachSocket` must not be able to
  // detach the session its successor is now using.
  if (session.ws !== ws) return;
  if (session.ended) return;

  session.ws = null;
  session.detachedAt = Date.now();

  // Nothing can ask for this shell again, so there is nothing to wait for.
  if (!session.reattachable) {
    endSession(session, "client-ended");
    return;
  }

  const graceMs = env.TERMINAL_DETACH_GRACE_SECONDS * 1000;

  // A deployment that would rather pay nothing for a dropped connection sets
  // the window to zero, and gets back exactly the behaviour this replaced.
  if (graceMs === 0) {
    endSession(session, "grace-expired");
    return;
  }

  increment("terminal_detached");

  session.graceTimer = setTimeout(() => {
    endSession(session, "grace-expired");
  }, graceMs);

  // Never a reason to hold the process open on its own.
  session.graceTimer.unref?.();

  logger.info("terminal detached", {
    projectId: session.projectId,
    terminalId: session.terminalId,
    graceSeconds: env.TERMINAL_DETACH_GRACE_SECONDS,
  });
}

/** Ends a session for good: the shell is hung up exactly as a close used to
 *  hang it up, and the container attachment is released.
 *
 *  Idempotent, because four different things end a session and two of them can
 *  arrive together — a shell that exits while the grace timer is firing.
 */
export function endSession(
  session: TerminalSession,
  reason: SessionEndReason,
): void {
  if (session.ended) return;
  session.ended = true;

  sessions.delete(session.id);

  if (session.graceTimer) {
    clearTimeout(session.graceTimer);
    session.graceTimer = null;
  }

  session.scrollback.clear();

  try {
    session.stream.end();
    session.stream.destroy();
  } catch {
    // Already torn down.
  }

  // The original teardown, unchanged and on the same pid file. Everything
  // above only decides when this happens.
  void hangUpShell(session.container, session.pidFile);

  session.release();
  increment("terminal_sessions_ended");

  logger.info("terminal session ended", {
    projectId: session.projectId,
    terminalId: session.terminalId,
    reason,
  });
}

/** Ends every session a project holds. The container is going away — a recreate,
 *  a stop, a delete — so there is nothing left to reattach to, and a session
 *  that outlived its container would hold an attachment against a container
 *  that no longer exists. */
export function endProjectSessions(
  projectId: string,
  reason: SessionEndReason,
): void {
  for (const session of projectSessions(projectId)) {
    if (session.ws) {
      try {
        session.ws.close(4002, "This project's container was stopped");
      } catch {
        // Already gone.
      }
    }
    endSession(session, reason);
  }
}

/** Ends every session belonging to one person on one project.
 *
 *  Access revocation. `watchAccess` already closes the socket when somebody is
 *  removed from a project or demoted to viewer, and before this change that
 *  close WAS the shell ending. It no longer is, so revocation has to say so:
 *  a detached session left running would be a shell inside somebody's
 *  container belonging to a person who has just lost access to it, and it
 *  would still be there when they reconnected.
 */
export function endUserSessions(
  userId: string,
  projectId: string,
  reason: SessionEndReason,
): void {
  const prefix = `${userId}:${projectId}:`;
  for (const session of sessions.values()) {
    if (session.id.startsWith(prefix)) endSession(session, reason);
  }
}

/** For tests: forget everything without signalling containers. */
export function resetSessionsForTest(): void {
  for (const session of sessions.values()) {
    if (session.graceTimer) clearTimeout(session.graceTimer);
  }
  sessions.clear();
}
