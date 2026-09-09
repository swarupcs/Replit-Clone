import type { Container, Exec } from "dockerode";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import { getTemplate } from "../templates/registry.js";
import { logger } from "../lib/logger.js";
import { env, watchPollingEnv } from "../config/env.js";
import {
  Scrollback,
  attachSocket,
  detachSocket,
  endSession,
  registerSession,
} from "../terminal/terminalSessions.js";
import type { TerminalSession } from "../terminal/terminalSessions.js";
import {
  hangUpShell,
  reclaimShells,
  shellArgv,
  shellNonce,
  terminalPidFile,
} from "./terminalShell.js";

/** Docker ignores a resize sent before the exec's process has claimed its TTY,
 *  and gives no error when it does. The requested size is re-sent at each of
 *  these offsets (ms) after start so the terminal ends up correctly sized. */
const EXEC_SETTLE_CHECKPOINTS_MS = [300, 900, 2000];

/** Control frames the client can send instead of raw keystrokes. */
interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

/** The client saying it is finished with this terminal, rather than losing it.
 *
 *  plan.md §13.7. Once a disconnect stops ending a shell, the two kinds of
 *  close have to be told apart, and only the client knows which is which: a
 *  socket that drops looks identical from here whether the user closed the
 *  pane on purpose or walked into a tunnel. Closing a pane deliberately should
 *  cost nothing and hold nothing, so the client says so before it goes and the
 *  session ends immediately instead of waiting out its grace window.
 */
interface EndMessage {
  type: "end";
}

type ControlMessage = ResizeMessage | EndMessage;

function parseControlMessage(raw: string): ControlMessage | undefined {
  if (!raw.startsWith('{"type":"resize"') && !raw.startsWith('{"type":"end"')) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;

    const message = parsed as ControlMessage;
    if (message.type === "end") return { type: "end" };

    if (message.type === "resize") {
      const { cols, rows } = message;
      if (Number.isInteger(cols) && Number.isInteger(rows)) {
        return { type: "resize", cols, rows };
      }
    }
  } catch {
    // Not JSON: ordinary terminal input.
  }
  return undefined;
}

/** Hands the caller's real input handler to a buffer that has been collecting
 *  client input since the socket opened. See `installTerminalGateway`. */
export type AttachInput = (handler: (data: string) => void) => void;

/** Re-applies the last size any client asked for, once the exec is warm. */
function applySize(session: TerminalSession, size: { w: number; h: number }): void {
  session.size = size;
  if (session.settled) void session.exec.resize(size).catch(() => {});
}

/** Wires one socket to a session's shell: input in, output out, and a close
 *  that detaches rather than hangs up.
 *
 *  Shared by the two ways a socket arrives — the one that created the session
 *  and every one that reconnects to it afterwards — because they differ only
 *  in whether there was already something to replay.
 */
export function bindSocketToSession(
  session: TerminalSession,
  ws: WebSocket,
  attachInput: AttachInput,
): void {
  const missed = attachSocket(session, ws);

  // Before any live output, and before the client's own first keystroke is
  // echoed: what happened while nobody was watching goes at the top of the
  // pane, in the order it was printed.
  if (missed && missed.length > 0 && ws.readyState === ws.OPEN) {
    ws.send(missed);
  }

  // A reconnect is usually a different window, and is often a different size.
  // Re-applying what this client asks for is the client's job; re-applying
  // what the session already knew is ours, so a pty is never left believing it
  // is the size of the window that left.
  if (session.size) applySize(session, session.size);

  attachInput((raw) => {
    const control = parseControlMessage(raw);
    if (control) {
      if (control.type === "end") {
        endSession(session, "client-ended");
        return;
      }
      applySize(session, { w: control.cols, h: control.rows });
      return;
    }

    session.stream.write(raw);
  });

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    detachSocket(session, ws);
  };

  // Where the whole of §13.7 lives, and it is one word: `detachSocket` rather
  // than the hangup this used to call. The hangup still happens — in
  // `endSession`, when the grace window expires with nobody attached.
  ws.on("close", release);
  ws.on("error", release);
}

/** Starts a shell for a project and wraps it in a session the client can
 *  reconnect to.
 *
 *  `release` is the caller's hold on the project's container, handed over
 *  here: from this point the SESSION owns it, not the socket, because a
 *  detached session with a build still running is a real use of that container
 *  and the idle reaper must not stop it out from under one.
 */
export const handleTerminalCreation = (
  container: Container,
  ws: WebSocket,
  templateId: string,
  attachInput: AttachInput,
  terminalId: number,
  /** The project's own start command, when it has one. `$START_COMMAND` is a
   *  hint the shell prints, and a hint that names a command the Run button does
   *  not run is worse than none. */
  startCommandOverride?: string,
  /** Identity of the session to register, and the release of the container
   *  attachment it takes ownership of. Absent in the tests that only care
   *  about the exec's shape. */
  session?: { id: string; projectId: string; release: () => void },
): void => {
  const template = getTemplate(templateId);
  const startCommand = startCommandOverride?.trim() || template.startCommand;
  const pidFile = terminalPidFile(terminalId, shellNonce());

  // Before this shell, not after: an earlier one under the same id may still
  // be holding the ports this one is about to be asked to bind. Not awaited —
  // opening a terminal must not wait on a signal to processes nobody is
  // listening to, and the sweep skips `pidFile` by name, so it is indifferent
  // to whether the new shell has recorded itself yet.
  void reclaimShells(container, terminalId, pidFile);

  container.exec(
    {
      Cmd: shellArgv(pidFile),
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      // Inherits the container's user, which is matched to the bind mount's
      // owner. See containerManager.
      WorkingDir: "/home/sandbox/app",
      Env: [
        "TERM=xterm-256color",
        `DEV_PORT=${template.devPort}`,
        `START_COMMAND=${startCommand}`,
        // A dev server started by hand from the shell needs the same treatment
        // as one started by the Run button.
        ...watchPollingEnv,
      ],
    },
    (err: Error | null, exec?: Exec) => {
      if (err || !exec) {
        logger.error("could not create terminal exec", err);
        session?.release();
        ws.close(1011, "Could not open a shell");
        return;
      }

      const startedExec = exec;

      // Creating an exec does not run anything, so a client that has already
      // gone costs nothing to abandon here — but starting one for it would
      // spawn a shell with nobody on the other end.
      //
      // Deliberately still true with sessions: nothing has been registered
      // yet, so there is nothing to reconnect to and no reason to hold a
      // container for a client that never arrived.
      if (ws.readyState !== ws.OPEN) {
        session?.release();
        return;
      }

      startedExec.start({ hijack: true, stdin: true }, (startErr, stream) => {
        if (startErr || !stream) {
          logger.error("could not start terminal exec", startErr);
          session?.release();
          ws.close(1011, "Could not start a shell");
          return;
        }

        // Docker answers `start` well after the request, and the socket may
        // have closed in between. A shell nobody ever saw is not a session
        // worth keeping — there is no scrollback to come back to and the
        // client has not been told an id it could ask for — so this window
        // keeps the behaviour it always had.
        if (ws.readyState !== ws.OPEN) {
          stream.end();
          stream.destroy();
          void hangUpShell(container, pidFile);
          session?.release();
          return;
        }

        const live: TerminalSession = {
          id: session?.id ?? `anonymous:${String(terminalId)}`,
          projectId: session?.projectId ?? "",
          terminalId,
          pidFile,
          container,
          exec: startedExec,
          stream,
          ws: null,
          scrollback: new Scrollback(env.TERMINAL_SCROLLBACK_BYTES),
          settled: false,
          detachedAt: null,
          graceTimer: null,
          release: session?.release ?? (() => {}),
          // A client that named no session gets the behaviour it has always
          // had: its shell is hung up when its socket goes, because nothing
          // could ever ask for that shell again.
          reattachable: Boolean(session),
          ended: false,
        };

        forwardOutput(stream, live);

        // Docker accepts a resize on a freshly started exec without erroring
        // but silently drops it, leaving the PTY at 0x0. Rather than guess a
        // single settle delay, the latest requested size is re-applied at a few
        // checkpoints; the first one that lands wins and the rest are no-ops.
        //
        // Per session rather than per socket now: a reconnect arriving after
        // the exec is warm must not restart a settling sequence that already
        // finished, and one arriving during it must not cancel it.
        for (const delay of EXEC_SETTLE_CHECKPOINTS_MS) {
          const timer = setTimeout(() => {
            if (live.ended) return;
            if (delay === EXEC_SETTLE_CHECKPOINTS_MS.at(-1)) live.settled = true;
            if (live.size) void startedExec.resize(live.size).catch(() => {});
          }, delay);
          timer.unref?.();
        }

        // A shell that exits — the user typed `exit`, or the container went —
        // ends the session outright. There is no pty left to reconnect to, so
        // holding one open for the grace window would be holding the project's
        // container for a shell that no longer exists.
        stream.on("end", () => {
          const attached = live.ws;
          endSession(live, "shell-exited");
          attached?.close();
        });

        if (session) registerSession(live);
        bindSocketToSession(live, ws, attachInput);
      });
    },
  );
};

/** How much unsent terminal output to hold for a client before pausing the
 *  process producing it.
 *
 *  Generous enough that an ordinary burst — an install, a stack trace, a test
 *  run — never stalls, and small enough that it cannot become a way to spend
 *  the server's memory.
 */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** Above this, output is dropped rather than buffered, and the terminal is
 *  told once. Reached only by a process writing far faster than any human is
 *  reading, where the bytes in flight have no value anyway. */
const DROP_THRESHOLD_BYTES = 16 * 1024 * 1024;

/** Forwards the exec's output to whoever is attached, or to the scrollback.
 *
 *  The exec is created with `Tty: true`, and Docker only frames a stream when
 *  there is NO TTY — with one, the bytes arrive raw. Parsing the 8-byte
 *  stream header anyway consumed the first eight bytes of the shell's output
 *  as a length prefix and then blocked forever waiting for a payload that size,
 *  so the terminal never rendered anything. `runner.ts` already documents the
 *  raw behaviour for its own exec; the two now agree.
 *
 *  Backpressure is the other half. `ws.send` queues whatever it cannot write
 *  yet, and this used to send unconditionally — so a process writing faster
 *  than the client drains (`yes`, a build loop, a verbose install over a slow
 *  link) grew that queue in the SERVER's memory until the process died. The
 *  container's own memory limit does not apply on this side of the socket.
 *
 *  A detached session has no client to push back on, so the bound moves to the
 *  scrollback: it keeps a fixed number of bytes and drops the oldest. Pausing
 *  the stream instead would be the wrong trade — it would stop the build the
 *  user detached in order to keep running.
 */
export function forwardOutput(stream: Duplex, session: TerminalSession): void {
  let warnedAboutDropping = false;

  stream.on("data", (chunk: Buffer) => {
    const ws = session.ws;

    if (!ws || ws.readyState !== ws.OPEN) {
      session.scrollback.write(chunk);
      return;
    }

    const buffered = ws.bufferedAmount;

    if (buffered > DROP_THRESHOLD_BYTES) {
      // Pausing alone is not enough at this rate: the producer is inside the
      // container and a paused stream only stops us reading, while Docker
      // keeps buffering. Say so once, then discard until it drains.
      if (!warnedAboutDropping) {
        warnedAboutDropping = true;
        ws.send("\r\n\x1b[33m[output is coming faster than it can be shown — some was dropped]\x1b[0m\r\n");
      }
      return;
    }

    warnedAboutDropping = false;
    ws.send(chunk);

    // Stop reading from Docker while the client catches up; the exec's own
    // writes then block, which is the pressure reaching the process itself.
    if (buffered > MAX_BUFFERED_BYTES && !stream.isPaused()) {
      stream.pause();
      waitForDrain(stream, session);
    }
  });
}

/** Resumes the exec stream once the client has caught up, or once it has gone.
 *
 *  A detached session resumes rather than staying paused forever: the reason
 *  to pause was a client that could not keep up, and there is no longer one.
 *  From then on the scrollback's own cap is what bounds it.
 */
function waitForDrain(stream: Duplex, session: TerminalSession): void {
  const timer = setInterval(() => {
    const ws = session.ws;

    if (!ws || ws.readyState !== ws.OPEN) {
      clearInterval(timer);
      if (!session.ended) stream.resume();
      return;
    }

    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return;

    clearInterval(timer);
    stream.resume();
  }, 50);

  // Never a reason to hold the process open on its own.
  timer.unref();
}
