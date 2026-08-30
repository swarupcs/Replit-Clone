import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import { BadRequestError, NotFoundError } from "../utils/errors.js";
import { ensureContainer } from "../containers/containerManager.js";
import { execCapture } from "../containers/execCapture.js";
import { TEMPLATES } from "../templates/registry.js";
import type { TestRun } from "@replit-clone/shared";

/** Running a project's tests, and showing what happened.
 *
 *  The loop this product did not have. A project could run, deploy and be
 *  scheduled, and the command people type most often had nowhere to show its
 *  results — so the answer to "did I break anything" was a terminal tab and
 *  reading scrollback.
 *
 *  Deliberately NOT a second scheduler. A test run has no history, no cron and
 *  no sweeper: it is one command, run when somebody asks, with its output. The
 *  moment it wants to run on a schedule it should be a scheduled job (§2.13),
 *  which already exists and already reports its outcomes properly.
 */

/** Longer than a scheduled job's, because a suite legitimately takes minutes
 *  and this one has a person waiting who can see that it is still going. */
const TEST_TIMEOUT_MS = 10 * 60 * 1000;

/** Kept from the tail, like a build log. A test run that fails prints the
 *  failures last, which is the part worth having. */
const MAX_OUTPUT = 60_000;

function tail(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `… ${String(text.length - MAX_OUTPUT)} earlier characters not shown …\n${text.slice(-MAX_OUTPUT)}`;
}

/** What this project's tests are, or null when nobody has said.
 *
 *  The project's own override wins; otherwise the template's default; and a
 *  template with no default means there is nothing to run. Null is answered as
 *  a question rather than a guess — running `npm test` in a Go project fails in
 *  a way its author cannot act on.
 */
export async function resolveTestCommand(
  projectId: string,
): Promise<{ command: string | null; fromTemplate: boolean }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { testCommand: true, template: true },
  });

  if (!project) throw new NotFoundError("No such project.", "NOT_FOUND");

  const own = project.testCommand?.trim();
  if (own) return { command: own, fromTemplate: false };

  const fallback = TEMPLATES[project.template]?.testCommand ?? null;
  return { command: fallback, fromTemplate: fallback !== null };
}

/** Sets or clears this project's own test command.
 *
 *  An empty string clears it, which is how somebody goes back to the
 *  template's default — distinct from a template that has none, and the panel
 *  says which of the two it is looking at.
 */
export async function setTestCommand(
  projectId: string,
  raw: string,
): Promise<{ command: string | null; fromTemplate: boolean }> {
  const command = raw.trim();

  if (command.length > 500) {
    throw new BadRequestError(
      "Keep the test command under 500 characters.",
      "COMMAND_TOO_LONG",
    );
  }

  await prisma.project.update({
    where: { id: projectId },
    data: { testCommand: command.length > 0 ? command : null },
  });

  return resolveTestCommand(projectId);
}

/** Runs the tests once, now.
 *
 *  The three outcomes are kept apart for the reason §2.13 gives about its six:
 *  "the tests failed", "they took too long", and "we could not run them at
 *  all" send the reader to three different places, and a panel that says
 *  "failed" for the third sends them to read their own code for a Docker
 *  outage.
 */
export async function runTests(projectId: string): Promise<TestRun> {
  const { command } = await resolveTestCommand(projectId);

  if (!command) {
    throw new BadRequestError(
      "This project has no test command. Set one to run tests.",
      "NO_TEST_COMMAND",
    );
  }

  const startedAt = new Date();
  increment("test_runs_started");

  try {
    const container = await ensureContainer(projectId);

    // A shell, for the reason the scheduler gives: the container is the
    // security boundary, whoever wrote this already has a terminal in the same
    // one, and argv splitting here would break every honest `a && b`.
    const result = await withTimeout(
      execCapture(container, ["/bin/sh", "-lc", command]),
      TEST_TIMEOUT_MS,
    );

    if (result === "timeout") {
      increment("test_runs_failed");
      return {
        status: "TIMED_OUT",
        command,
        exitCode: null,
        output:
          `Gave up after ${String(TEST_TIMEOUT_MS / 60000)} minutes. The ` +
          `command may still be running inside the container.`,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
      };
    }

    const output = [result.stdout, result.stderr]
      .filter((part) => part.length > 0)
      .join("\n");

    increment(result.exitCode === 0 ? "test_runs_passed" : "test_runs_failed");

    return {
      status: result.exitCode === 0 ? "PASSED" : "FAILED",
      command,
      exitCode: result.exitCode,
      output: tail(output),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
  } catch (error) {
    // Docker down, capacity full, no working tree. The tests are fine; the
    // machine could not run them, and that is a different sentence from "your
    // tests failed".
    increment("test_runs_errored");
    logger.error("could not run a project's tests", error, { projectId });

    return {
      status: "ERRORED",
      command,
      exitCode: null,
      output:
        error instanceof Error ? error.message : "Could not start the tests.",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }
}

/** Resolves the work or "timeout", and PASSES ON a rejection.
 *
 *  Deliberately not folding a rejection into "timeout" — that was the defect
 *  in the scheduler's copy of this (§2.15), where an exec that threw was
 *  reported as a run that took too long and told its owner the command "may
 *  still be running" when it was not running anywhere.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve("timeout");
    }, ms);
    timer.unref?.();

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
