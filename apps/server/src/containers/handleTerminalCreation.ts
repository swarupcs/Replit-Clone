import type { Container, Exec } from "dockerode";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import { getTemplate } from "../templates/registry.js";

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
): void => {
  const template = getTemplate(templateId);

  container.exec(
    {
      Cmd: ["/bin/bash"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      User: "sandbox",
      WorkingDir: "/home/sandbox/app",
      Env: [
        "TERM=xterm-256color",
        `DEV_PORT=${template.devPort}`,
        `START_COMMAND=${template.startCommand}`,
      ],
    },
    (err: Error | null, exec?: Exec) => {
      if (err || !exec) {
        console.error("Error while creating exec:", err);
        ws.close(1011, "Could not open a shell");
        return;
      }

      const startedExec = exec;

      startedExec.start({ hijack: true, stdin: true }, (startErr, stream) => {
        if (startErr || !stream) {
          console.error("Error while starting exec:", startErr);
          ws.close(1011, "Could not start a shell");
          return;
        }

        processStreamOutput(stream, ws);

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

        // The exec stream was previously never cleaned up on disconnect.
        const cleanup = (): void => {
          settleTimers.forEach(clearTimeout);
          stream.end();
          stream.destroy();
        };

        ws.on("close", cleanup);
        ws.on("error", cleanup);
        stream.on("end", () => ws.close());
      });
    },
  );
};

/** Demultiplexes Docker's stream framing.
 *
 *  Each frame is an 8-byte header — a big-endian uint32 stream type followed by
 *  a big-endian uint32 payload length — then that many payload bytes. We buffer
 *  until a whole frame is available, forward the payload, and repeat.
 */
function processStreamOutput(stream: Duplex, ws: WebSocket): void {
  let nextDataType: number | null = null;
  let nextDataLength: number | null = null;
  let buffer: Buffer = Buffer.alloc(0);

  function takeFromBuffer(end: number): Buffer {
    const output = buffer.subarray(0, end);
    buffer = Buffer.from(buffer.subarray(end));
    return output;
  }

  function processStreamData(data?: Buffer): void {
    if (data) buffer = Buffer.concat([buffer, data]);

    if (nextDataType === null) {
      if (buffer.length >= 8) {
        const header = takeFromBuffer(8);
        nextDataType = header.readUInt32BE(0);
        nextDataLength = header.readUInt32BE(4);
        processStreamData();
      }
    } else if (nextDataLength !== null && buffer.length >= nextDataLength) {
      const content = takeFromBuffer(nextDataLength);
      if (ws.readyState === ws.OPEN) ws.send(content);
      nextDataType = null;
      nextDataLength = null;
      processStreamData();
    }
  }

  stream.on("data", (chunk: Buffer) => processStreamData(chunk));
}
