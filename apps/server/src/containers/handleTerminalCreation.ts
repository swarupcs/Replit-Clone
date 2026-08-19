import type { Container, Exec } from "dockerode";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";

export const handleTerminalCreation = (
  container: Container,
  ws: WebSocket,
): void => {
  container.exec(
    {
      Cmd: ["/bin/bash"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      User: "sandbox",
    },
    (err: Error | null, exec?: Exec) => {
      if (err || !exec) {
        console.error("Error while creating exec", err);
        return;
      }

      exec.start({ hijack: true, stdin: true }, (startErr, stream) => {
        if (startErr || !stream) {
          console.error("Error while starting exec", startErr);
          return;
        }

        processStreamOutput(stream, ws);

        ws.on("message", (data) => {
          stream.write(data as Buffer);
        });

        ws.on("close", () => {
          stream.end();
        });
      });
    },
  );
};

/** Demultiplexes Docker's stream framing.
 *
 *  Each frame is an 8-byte header — a big-endian uint32 stream type followed by
 *  a big-endian uint32 payload length — and then that many payload bytes. We
 *  buffer until a whole frame is available, forward the payload, and repeat.
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
    if (data) {
      buffer = Buffer.concat([buffer, data]);
    }

    if (nextDataType === null) {
      if (buffer.length >= 8) {
        const header = takeFromBuffer(8);
        nextDataType = header.readUInt32BE(0);
        nextDataLength = header.readUInt32BE(4);
        processStreamData();
      }
    } else if (nextDataLength !== null && buffer.length >= nextDataLength) {
      const content = takeFromBuffer(nextDataLength);
      ws.send(content);
      nextDataType = null;
      nextDataLength = null;
      processStreamData();
    }
  }

  stream.on("data", (chunk: Buffer) => processStreamData(chunk));
}
