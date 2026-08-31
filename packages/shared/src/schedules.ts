/** Cron jobs for a project: the cheap half of always-on compute.
 *
 *  A deployment is a process that must exist whenever a request might arrive.
 *  A scheduled job is a command that exists for a minute and then does not —
 *  the same machinery, a different cost model, and in the direction that costs
 *  less. It is also what people mean when they ask whether their project can
 *  keep doing something after they close the tab: backups, fetches, digests.
 *
 *  Autoscaling is the other half of that row in the plan and is still open,
 *  because deciding how much compute to *buy* is a pricing question. Deciding
 *  when to use the compute that already exists is not.
 */

/** What happened to one execution.
 *
 *  Seven states rather than pass/fail, because the interesting answers here
 *  are the ones that are neither. "It did not run" and "it ran and failed" are
 *  different problems with different fixes, and a schedule that reports them
 *  identically sends people to read the wrong logs.
 */
export type ScheduledRunStatus =
  | "RUNNING"
  | "SUCCEEDED"
  /** Exited non-zero. The command's problem. */
  | "FAILED"
  /** The previous run had not finished. Recorded rather than silently passed
   *  over, so an overlapping schedule looks like the misconfiguration it is
   *  instead of like a job that quietly stopped firing. */
  | "SKIPPED"
  /** Gave up waiting. The command may still be running inside the container:
   *  this abandons the exec, it does not kill it. */
  | "TIMED_OUT"
  /** Never started — no container, no Docker, no project tree. The
   *  platform's problem rather than the command's. */
  | "ERRORED"
  /** The server stopped existing while this run was in progress.
   *
   *  Its own status rather than `ERRORED`, which says the machine never got
   *  the command started: here it did, and the command may well have finished
   *  — a backup that completed at 03:00 and a deploy at 03:01 produce this.
   *  That is the same distinction `TIMED_OUT` is kept apart from `FAILED` for,
   *  and it changes what the owner should do: re-run an `ERRORED` job, look at
   *  what the command actually did before re-running an `ABANDONED` one.
   *
   *  Not a verdict, so a job that runs normally next time says nothing. */
  | "ABANDONED";

export interface ScheduledRun {
  id: string;
  startedAt: string;
  /** Null while the run is still going, which is exactly how a stuck run is
   *  visible rather than indistinguishable from one that never happened. */
  finishedAt: string | null;
  status: ScheduledRunStatus;
  /** The process's exit code, or null when it never got as far as one. */
  exitCode: number | null;
  /** The tail of stdout and stderr, truncated. The tail rather than the head,
   *  because the useful line in a failed job is almost always the last one. */
  output: string | null;
}

export interface ScheduledJob {
  id: string;
  projectId: string;
  name: string;
  /** Five cron fields, **UTC**. Returned exactly as it was written: a round
   *  trip through the parser would hand back something correct that the owner
   *  did not type. */
  schedule: string;
  command: string;
  enabled: boolean;
  /** When it next fires. Null while disabled, and null when the expression
   *  parses but matches no reachable instant — `0 0 30 2 *` is valid cron and
   *  will never happen. */
  nextRunAt: string | null;
  createdAt: string;
  /** The most recent run, so a list can answer "did last night's job work"
   *  without a request per row. */
  lastRun: ScheduledRun | null;
}

/** The most jobs one project may hold.
 *
 *  Per project rather than per machine: a cap on the machine would let one
 *  busy project exhaust everybody else's, which is a different product than
 *  the one where your own limit is yours.
 */
export const MAX_JOBS_PER_PROJECT = 10;

/** The shortest gap between two firings of the same job.
 *
 *  Not because a more frequent expression is wrong, but because this
 *  platform's unit of work is a container. One start per minute forever is a
 *  cost model nothing here was built for, and the refusal belongs at the
 *  moment somebody types it rather than in a bill.
 */
export const MIN_INTERVAL_MINUTES = 5;
