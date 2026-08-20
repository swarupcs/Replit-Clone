import type { Container } from "dockerode";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Largest output we will buffer from one exec.
 *
 *  `git diff` on a generated file has no natural bound, and this all lands in
 *  the server's memory before anyone sees it. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Docker's stream multiplexing header: one byte of stream id, three padding
 *  bytes, then a big-endian uint32 payload length. */
const HEADER_BYTES = 8;
const STREAM_STDERR = 2;

/** Runs a command in a project's container and collects what it wrote.
 *
 *  Deliberately NOT a TTY. The terminal and the run command both allocate one,
 *  which makes Docker send the stream raw -- fine when the bytes are going
 *  straight to xterm, useless here, because stdout and stderr arrive
 *  interleaved with no way to tell them apart. Without a TTY Docker frames the
 *  stream instead, one length-prefixed header per chunk, which is what lets us
 *  split it back into the two channels below.
 *
 *  The framed bytes are buffered off the raw hijacked stream, which ends on its
 *  own when the exec finishes, and demuxed afterwards. An earlier version piped
 *  the stream through `modem.demuxStream` into two PassThroughs and waited for
 *  each to emit `end` -- but demuxStream copies bytes without ever ending its
 *  destinations, so the wait never resolved and every exec hung forever. The
 *  hang was invisible to the unit tests, which exercise the parsers rather than
 *  a live container.
 *
 *  `argv` is passed as an array, so it is exec'd directly rather than through a
 *  shell: a branch named `;rm -rf /` is then an argument, not a command.
 */
export async function execCapture(
  container: Container,
  argv: string[],
  options: { workingDir?: string } = {},
): Promise<ExecResult> {
  const exec = await container.exec({
    Cmd: argv,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    WorkingDir: options.workingDir ?? "/home/sandbox/app",
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };

    stream.on("data", (chunk: Buffer) => {
      // Keep reading past the cap so the stream still ends on its own; pausing
      // would leave the exec blocked on a full pipe.
      if (size >= MAX_OUTPUT_BYTES) return;
      size += chunk.length;
      chunks.push(chunk);
    });
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", reject);
  });

  const { stdout, stderr } = demux(raw);
  const { ExitCode } = await exec.inspect();

  return { stdout, stderr, exitCode: ExitCode ?? 0 };
}

/** Splits Docker's multiplexed exec output into stdout and stderr.
 *
 *  Exported for testing: the framing is exactly the sort of off-by-one-prone
 *  parsing that earns a unit test, and it needs none of the Docker plumbing to
 *  exercise. A frame whose declared length runs past the buffer (output capped
 *  mid-frame) is taken up to the end rather than dropped.
 */
export function demux(raw: Buffer): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  let offset = 0;

  while (offset + HEADER_BYTES <= raw.length) {
    const streamId = raw[offset];
    const length = raw.readUInt32BE(offset + 4);
    const start = offset + HEADER_BYTES;
    const end = Math.min(start + length, raw.length);
    const payload = raw.subarray(start, end).toString("utf8");

    if (streamId === STREAM_STDERR) stderr += payload;
    else stdout += payload;

    offset = start + length;
  }

  return { stdout, stderr };
}
