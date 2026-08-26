import type { Container, Exec } from "dockerode";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import { getTemplate } from "../templates/registry.js";
import { logger } from "../lib/logger.js";
import { watchPollingEnv } from "../config/env.js";
import { hangUpShell, shellArgv, terminalPidFile } from "./terminalShell.js";

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

function parseControlMessage(raw: string): ResizeMessage | undefined {
  if (!raw.startsWith('{"type":"resize"')) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as ResizeMessage).type === "resize"
    ) {
      const { cols, rows } = parsed as ResizeMessage;
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
): void => {
  const template = getTemplate(templateId);
  const startCommand = startCommandOverride?.trim() || template.startCommand;
  const pidFile = terminalPidFile(terminalId);

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
        ws.close(1011, "Could not open a shell");
        return;
      }

      const startedExec = exec;

      // Creating an exec does not run anything, so a client that has already
      // gone costs nothing to abandon here — but starting one for it would
      // spawn a shell with nobody on the other end.
      if (ws.readyState !== ws.OPEN) return;

      startedExec.start({ hijack: true, stdin: true }, (startErr, stream) => {
        if (startErr || !stream) {
          logger.error("could not start terminal exec", startErr);
          ws.close(1011, "Could not start a shell");
          return;
        }

        // Docker answers `start` well after the request, and the socket may
        // have closed in between. Everything that tears this shell down hangs
        // off `ws.on("close")`, registered at the END of this callback — so a
        // socket that closed before we got here was never going to be heard,
        // and its shell stayed in the container until the container itself
        // went away. Close the stream now instead.
        if (ws.readyState !== ws.OPEN) {
          stream.end();
          stream.destroy();
          void hangUpShell(container, pidFile);
          return;
        }

        forwardOutput(stream, ws);

        // Docker accepts a resize on a freshly started exec without erroring
        // but silently drops it, leaving the PTY at 0x0. Rather than guess a
        // single settle delay, the latest requested size is re-applied at a few
        // checkpoints; the first one that lands wins and the rest are no-ops.
        let latestSize: { w: number; h: number } | undefined;
        let settled = false;

        const settleTimers = EXEC_SETTLE_CHECKPOINTS_MS.map((delay) =>
          setTimeout(() => {
            if (delay === EXEC_SETTLE_CHECKPOINTS_MS.at(-1)) settled = true;
            if (latestSize) void startedExec.resize(latestSize).catch(() => {});
          }, delay),
        );

        function applySize(size: { w: number; h: number }): void {
          latestSize = size;
          // Once the exec is warm, resizes take effect immediately.
          if (settled) void startedExec.resize(size).catch(() => {});
        }

        // Replays anything typed or resized while the exec was starting.
        attachInput((raw) => {
          // Terminal resize was entirely missing, so the shell always believed
          // it had xterm's default size regardless of the pane's real size.
          const control = parseControlMessage(raw);
          if (control) {
            applySize({ w: control.cols, h: control.rows });
            return;
          }

          stream.write(raw);
        });

        // The exec stream was previously never cleaned up on disconnect —
        // and closing it turned out not to be enough on its own. See
        // terminalShell.ts: Docker keeps the pty open, so the shell survives
        // its own terminal unless something hangs it up.
        let ended = false;
        const cleanup = (): void => {
          if (ended) return;
          ended = true;
          settleTimers.forEach(clearTimeout);
          stream.end();
          stream.destroy();
          void hangUpShell(container, pidFile);
        };

        ws.on("close", cleanup);
        ws.on("error", cleanup);
        stream.on("end", () => ws.close());
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

/** Forwards the exec's output to the client.
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
 */
export function forwardOutput(stream: Duplex, ws: WebSocket): void {
  let warnedAboutDropping = false;

  stream.on("data", (chunk: Buffer) => {
    if (ws.readyState !== ws.OPEN) return;

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
      waitForDrain(stream, ws);
    }
  });
}

/** Resumes the exec stream once the client has caught up. */
function waitForDrain(stream: Duplex, ws: WebSocket): void {
  const timer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) {
      clearInterval(timer);
      return;
    }

    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return;

    clearInterval(timer);
    stream.resume();
  }, 50);

  // Never a reason to hold the process open on its own.
  timer.unref();
}
