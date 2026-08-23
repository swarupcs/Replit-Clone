import type { Container, Exec } from "dockerode";
import type { Duplex } from "node:stream";
import { execCapture } from "./execCapture.js";

/** Keeping a record of the run's output where the run itself lives.
 *
 *  The output of a dev server used to exist only as bytes flowing through this
 *  process. Docker keeps no copy of an exec's output, so anything that ended
 *  the process ended the log with it: a deploy, a crash, `tsx watch` noticing a
 *  saved file. The dev server carried on serving, and the project came back
 *  with a "Running" badge over an empty Output pane that would never fill —
 *  not because the server had stopped saying anything, but because nothing was
 *  listening any more, and nothing could start.
 *
 *  That is worst exactly when the output matters most. Opening a new project
 *  runs `npm install` before the dev server, which is minutes of the only
 *  feedback there is; a reload during it showed nothing at all, and left the
 *  user with a blank pane and no way to tell "installing" from "broken".
 *
 *  So the run writes its output to a file inside the container as well as to
 *  this process. The file outlives us, which means a server that has just
 *  restarted can replay what it missed and then follow the rest.
 *
 *  `script` rather than `tee` because a pipe is not a terminal: `cmd | tee`
 *  makes the dev server's stdout a pipe, and every tool worth watching checks
 *  for a tty before it emits colour or redraws a progress line. `script`
 *  allocates a pty for the command and records what crosses it, so the log and
 *  the live stream carry the same bytes the user would have seen.
 */

/** Inside the container, beside the process group id the run records for
 *  `stopRun`. `/tmp` because it is the run's own scratch space and must not
 *  appear in the user's file tree — it is our bookkeeping, not their project. */
export const RUN_LOG_FILE = "/tmp/rc-run.log";

/** How much of the log to replay to a client that arrives late. Enough to
 *  cover an `npm install` and the dev server's banner after it; bounded
 *  because it is read into this process's memory and sent to every tab. */
const REPLAY_LINES = 400;
const REPLAY_BYTES = 128 * 1024;

/** Wraps the run so its output is recorded as well as streamed.
 *
 *  `-q` keeps the "Script started" banner off the live stream (it still lands
 *  in the file, where `stripRecordingBanner` takes it off the replay).
 *  `-e` returns the command's own exit code, which is what tells a failed run
 *  from a stopped one. `-f` flushes after every write, without which a
 *  follower reads the log in 4KB lurches and the Output pane arrives in
 *  chunks minutes after the fact.
 *
 *  `exec /bin/bash -lc` inside: `script` would otherwise run the command with
 *  `$SHELL -c`, which is `sh` in these images and not a login shell, so a
 *  template whose start command relies on the PATH set up by the profile
 *  would fail. `exec` keeps the pid — and so the process group the run reports
 *  for `stopRun` — the one `script` already made a session leader.
 */
export function recordedRunArgv(runScript: string): string[] {
  return [
    "/bin/bash",
    "-lc",
    `script -q -e -f -c ${shellQuote(`exec /bin/bash -lc ${shellQuote(runScript)}`)} ${RUN_LOG_FILE}`,
  ];
}

/** Wraps a string as a single-quoted shell word.
 *
 *  Lives here rather than in the runner because this is the only place that
 *  builds a shell command out of anything it did not write itself — the
 *  template's start command goes through it twice, once for each shell it is
 *  handed down through. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `script` brackets its recording with two lines of its own. They are its
 *  bookkeeping, not the run's output, and the second one repeats an exit code
 *  the run state already reports properly. */
export function stripRecordingBanner(log: string): string {
  return log
    .replace(/^Script started on [^\n]*\[COMMAND=[^\n]*\r?\n/, "")
    .replace(/\r?\nScript done on [^\n]*\[COMMAND_EXIT_CODE=[^\n]*\r?\n?$/, "");
}

/** Keeps the replay to its budget, cutting at a line boundary so it does not
 *  open mid-escape-sequence and leave the pane in an inherited colour. */
export function tailWithinBudget(log: string, budget = REPLAY_BYTES): string {
  if (log.length <= budget) return log;

  const cut = log.slice(log.length - budget);
  const firstBreak = cut.indexOf("\n");

  return firstBreak === -1 ? cut : cut.slice(firstBreak + 1);
}

/** What the run has said so far, or undefined when there is no recording —
 *  a container that has never run anything, or one started before this
 *  existed. Undefined and "" are different answers and the caller acts on the
 *  difference, so a missing file must not read as an empty log. */
export async function readRunLog(
  container: Container,
): Promise<string | undefined> {
  const result = await execCapture(container, [
    "/bin/sh",
    "-c",
    `[ -f ${RUN_LOG_FILE} ] && tail -n ${String(REPLAY_LINES)} ${RUN_LOG_FILE}`,
  ]).catch(() => undefined);

  if (!result || result.exitCode !== 0) return undefined;

  return tailWithinBudget(stripRecordingBanner(result.stdout));
}

export interface LogFollower {
  stop: () => void;
}

/** Streams what the run says from now on.
 *
 *  `-n 0` because whatever came before has already been replayed; following
 *  from the start would show it twice. `Tty: true` so Docker hands the bytes
 *  over unframed, which is what they already are — the recording is a
 *  terminal's worth of output and goes straight to the pane.
 */
export async function followRunLog(
  container: Container,
  onChunk: (chunk: string) => void,
): Promise<LogFollower> {
  const exec: Exec = await container.exec({
    Cmd: ["tail", "-n", "0", "-f", RUN_LOG_FILE],
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
  });

  const stream: Duplex = await exec.start({ hijack: true, stdin: false });

  stream.on("data", (chunk: Buffer) => {
    onChunk(chunk.toString("utf8"));
  });

  // A follower that fails is a pane that stops updating, not a broken run.
  stream.on("error", () => undefined);

  return {
    stop: () => {
      stream.destroy();
    },
  };
}
