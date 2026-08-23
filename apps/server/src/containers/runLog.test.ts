import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Container } from "dockerode";

const execCapture =
  vi.fn<
    (
      container: unknown,
      argv: string[],
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  >();

vi.mock("./execCapture.js", () => ({
  execCapture: (container: unknown, argv: string[]): unknown =>
    execCapture(container, argv),
}));

const {
  RUN_LOG_FILE,
  readRunLog,
  recordedRunArgv,
  shellQuote,
  stripRecordingBanner,
  tailWithinBudget,
} = await import("./runLog.js");

const container = {} as Container;

beforeEach(() => {
  vi.clearAllMocks();
});

/** The recording is what a client sees after the server that started the run
 *  has gone. These pin down the shape of it: what the run is wrapped in, and
 *  what has to come back off the file before anyone reads it. */

describe("wrapping the run so its output is recorded", () => {
  const argv = recordedRunArgv("npm install && npm run dev");
  const command = argv.join(" ");

  it("writes the recording where the reader looks for it", () => {
    expect(command).toContain(RUN_LOG_FILE);
  });

  /** Without `-e`, `script` returns its OWN exit status and every failed run
   *  reports success — which is the difference between "your build broke" and
   *  "the dev server stopped for no stated reason". */
  it("returns the command's exit code rather than its own", () => {
    expect(argv[2]).toContain("script -q -e -f");
  });

  /** `script` runs its command with `$SHELL -c`, which is `sh` in these images
   *  and not a login shell. A template whose start command needs the PATH the
   *  profile sets up would fail before it printed anything. */
  it("runs the command in a login bash", () => {
    expect(command).toContain("exec /bin/bash -lc");
  });

  /** `exec` keeps the pid, and that pid is the process group `stopRun`
   *  signals. A forked shell would leave Stop signalling the wrong group. */
  it("keeps the pid the process group is recorded from", () => {
    expect(command).toContain("exec /bin/bash");
    expect(command).not.toContain("& wait");
  });

  it("passes the start command through as one word, whatever is in it", () => {
    const nasty = recordedRunArgv("echo 'it''s' && npm run dev");
    expect(nasty[0]).toBe("/bin/bash");
    expect(nasty).toHaveLength(3);
  });
});

describe("shellQuote", () => {
  it("wraps a plain word", () => {
    expect(shellQuote("npm run dev")).toBe("'npm run dev'");
  });

  /** The POSIX idiom: close the quote, escape one apostrophe, reopen. That it
   *  actually round-trips through a real shell is pinned in runner.test.ts,
   *  which runs bash rather than trusting this reading of it. */
  it("survives an embedded single quote", () => {
    expect(shellQuote("it's")).toBe("'it'" + String.raw`\'` + "'s'");
  });
});

/** `script` brackets its recording with two lines of its own. They are its
 *  bookkeeping, and the second repeats an exit code the run state already
 *  reports properly. */
describe("the recorder's own banner", () => {
  const started =
    'Script started on 2026-08-23 11:37:06+00:00 [COMMAND="npm run dev"]\n';
  const done =
    '\nScript done on 2026-08-23 11:37:07+00:00 [COMMAND_EXIT_CODE="0"]\n';

  it("is taken off the front", () => {
    expect(stripRecordingBanner(`${started}> next dev\n`)).toBe("> next dev\n");
  });

  it("is taken off the end", () => {
    expect(stripRecordingBanner(`> next dev\n${done}`)).toBe("> next dev\n");
  });

  /** A log read while the run is still going has no closing banner, which is
   *  the common case: it is read precisely because something is still running. */
  it("leaves an unfinished recording alone", () => {
    expect(stripRecordingBanner(`${started}added 214 packages\n`)).toBe(
      "added 214 packages\n",
    );
  });

  /** The replay is a TAIL, so on a long-running dev server the opening banner
   *  scrolled out of the window long ago and there is nothing to strip. */
  it("leaves output that never had a banner alone", () => {
    expect(stripRecordingBanner("compiled in 84ms\n")).toBe("compiled in 84ms\n");
  });

  /** Anchored, so a project whose own output mentions the word is not eaten. */
  it("does not strip a line the run wrote itself", () => {
    const theirs = "Script started on the server, apparently\n";
    expect(stripRecordingBanner(theirs)).toBe(theirs);
  });
});

describe("keeping the replay to its budget", () => {
  it("passes a short log through untouched", () => {
    expect(tailWithinBudget("small\n", 100)).toBe("small\n");
  });

  it("keeps the END of a long one, which is the part that is current", () => {
    const log = "old\n".repeat(50) + "newest\n";

    expect(tailWithinBudget(log, 20)).toContain("newest");
  });

  /** Cutting mid-line can cut mid-escape-sequence, and the pane then wears
   *  whatever colour the fragment happened to open. */
  it("cuts at a line boundary", () => {
    const log = "aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n";

    const cut = tailWithinBudget(log, 15);

    expect(cut.split("\n")[0]).toMatch(/^(|[abc]{10})$/);
    expect(cut.endsWith("cccccccccc\n")).toBe(true);
  });

  /** One line longer than the whole budget has no boundary to cut at. Losing
   *  it entirely would be worse than showing the tail of it. */
  it("still returns something for a single enormous line", () => {
    expect(tailWithinBudget("x".repeat(100), 10)).toBe("x".repeat(10));
  });
});

/** Reading the recording back is what an adopting server does before it says
 *  anything to the client, so what it hands over is what the user reads. */
describe("reading the recording back", () => {
  function containerHolds(
    stdout: string,
    exitCode = 0,
  ): void {
    execCapture.mockResolvedValue({ stdout, stderr: "", exitCode });
  }

  it("reads the log the run writes to", async () => {
    containerHolds("");

    await readRunLog(container);

    expect(execCapture.mock.calls[0]?.[1].join(" ")).toContain(RUN_LOG_FILE);
  });

  it("hands back what the run said", async () => {
    containerHolds("compiled in 84ms\n");

    await expect(readRunLog(container)).resolves.toBe("compiled in 84ms\n");
  });

  /** The recorder's own banner is not the run's output, and it opens the
   *  replayed pane with a line about a command the user never typed. */
  it("takes the recorder's banner off before handing it back", async () => {
    containerHolds(
      'Script started on 2026-08-23 [COMMAND="npm run dev"]\n> next dev\n',
    );

    await expect(readRunLog(container)).resolves.toBe("> next dev\n");
  });

  /** Absent and empty are different answers, and the caller acts on the
   *  difference — one says "your output from before was not recorded", the
   *  other prints a heading over nothing. A container that has never run
   *  anything has no file, and `tail` fails rather than printing nothing. */
  it("is undefined when there is no recording at all", async () => {
    containerHolds("", 1);

    await expect(readRunLog(container)).resolves.toBeUndefined();
  });

  it("is undefined rather than throwing when the container will not answer", async () => {
    execCapture.mockRejectedValue(new Error("container is not running"));

    await expect(readRunLog(container)).resolves.toBeUndefined();
  });

  /** A dev server left running for a day has a log nobody wants sent to every
   *  tab in full. */
  it("keeps a very long recording within budget", async () => {
    containerHolds("x".repeat(400_000));

    const log = await readRunLog(container);

    expect(log?.length).toBeLessThan(200_000);
  });
});
