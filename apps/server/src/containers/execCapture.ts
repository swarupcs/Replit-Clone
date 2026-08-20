import { PassThrough } from "node:stream";
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

/** Runs a command in a project's container and collects what it wrote.
 *
 *  Deliberately NOT a TTY. The terminal and the run command both allocate one,
 *  which makes Docker send the stream raw -- fine when the bytes are going
 *  straight to xterm, useless here, because stdout and stderr arrive
 *  interleaved with no way to tell them apart. Without a TTY Docker frames the
 *  stream instead, and `demuxStream` splits it back into the two channels.
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

  const out = new PassThrough();
  const err = new PassThrough();

  // dockerode types `modem` loosely, so the one method used here is named
  // rather than reached for through `any`.
  const modem = container.modem as unknown as {
    demuxStream: (
      source: NodeJS.ReadableStream,
      stdout: NodeJS.WritableStream,
      stderr: NodeJS.WritableStream,
    ) => void;
  };
  modem.demuxStream(stream, out, err);

  const collect = (source: PassThrough): Promise<string> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;

      source.on("data", (chunk: Buffer) => {
        // Keep reading after the cap so the stream still ends on its own;
        // pausing here would leave the exec waiting on a full pipe.
        if (size >= MAX_OUTPUT_BYTES) return;
        size += chunk.length;
        chunks.push(chunk);
      });
      source.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });

  const [stdout, stderr] = await Promise.all([collect(out), collect(err)]);

  await new Promise<void>((resolve) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
  });

  const { ExitCode } = await exec.inspect();

  return { stdout, stderr, exitCode: ExitCode ?? 0 };
}
