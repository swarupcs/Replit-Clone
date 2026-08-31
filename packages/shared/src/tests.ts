/** Running a project's tests.
 *
 *  The loop this product did not have: a project could run, deploy and be
 *  scheduled, and the command people type most often had nowhere to show its
 *  results.
 *
 *  Deliberately not a second scheduler. There is no history and no cron here —
 *  one command, run when somebody asks. The moment it wants to run on a
 *  schedule it should be a scheduled job, which already reports outcomes
 *  properly.
 */

/** How a run ended.
 *
 *  Four, not two, for the reason the scheduler keeps six: "the tests failed",
 *  "they took too long" and "we could not run them at all" send the reader to
 *  three different places. A panel that says "failed" for the last one sends
 *  somebody to read their own code for a Docker outage.
 */
export type TestRunStatus =
  | "PASSED"
  /** Exited non-zero. The tests' verdict, which is the useful case. */
  | "FAILED"
  /** Gave up waiting. The command may still be running in the container. */
  | "TIMED_OUT"
  /** Never reached a container at all. Not the tests' fault. */
  | "ERRORED";

export interface TestRun {
  status: TestRunStatus;
  /** What actually ran. Shown, because "tests failed" is not actionable
   *  without knowing which command produced it. */
  command: string;
  exitCode: number | null;
  output: string;
  startedAt: string;
  finishedAt: string;
}

export interface TestCommand {
  /** Null when neither the project nor its template names one. */
  command: string | null;
  /** True when this is the template's default rather than the project's own
   *  choice — so the panel can say which it is looking at. */
  fromTemplate: boolean;
}
