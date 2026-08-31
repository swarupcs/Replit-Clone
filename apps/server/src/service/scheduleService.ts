import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../utils/errors.js";
import { CronError, nextRunOf, parseCron, nextRun } from "../lib/cron.js";
import { ensureContainer } from "../containers/containerManager.js";
import { execCapture } from "../containers/execCapture.js";
import {
  MAX_JOBS_PER_PROJECT,
  MIN_INTERVAL_MINUTES,
  type ScheduledJob as ApiJob,
  type ScheduledRun as ApiRun,
} from "@replit-clone/shared";
import { notify } from "./notificationService.js";
import { assertFeature } from "./entitlementService.js";

/** Cron jobs for a project: the cheap half of always-on compute.
 *
 *  A deployment is a process that must exist whenever a request might arrive.
 *  A scheduled job is a command that exists for a minute and then does not,
 *  which is a different cost model in the direction that costs less — and it
 *  is what people are asking for when they ask whether their project can keep
 *  doing something after they close the tab. Backups, fetches, digests.
 *
 *  Three decisions carry most of this file:
 *
 *  1. **The next firing is stored, not derived.** `nextRunAt` is written when
 *     the job is saved and rewritten when it runs, so the sweeper is one
 *     indexed query rather than a scan that parses every expression on the
 *     machine every minute.
 *
 *  2. **A missed window fires once, not once per miss.** A server down for a
 *     day owes an hourly job twenty-four runs by the calendar, and running
 *     them is never what anybody wanted — twenty-four backups at once, or
 *     twenty-four identical emails. The catch-up runs once and the schedule
 *     resumes from now.
 *
 *  3. **Overlap is recorded, not queued.** If the previous run has not
 *     finished, this one is written as SKIPPED rather than started behind it.
 *     A queue would turn a job that is slower than its own schedule into an
 *     unbounded backlog, which is the failure that takes the machine with it.
 */

/** How long one run may take before the sweeper stops waiting for it.
 *
 *  This ABANDONS the exec; it does not kill it. Docker has no "cancel exec",
 *  and the honest options are to wait forever or to stop waiting — so the run
 *  is recorded TIMED_OUT and the status text says the command may still be
 *  running. The container's own memory and pid limits are what actually bound
 *  a runaway, and the idle reaper is what eventually collects it.
 */
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

/** Kept from the end of the combined output.
 *
 *  The tail rather than the head: the useful line in a job that failed is
 *  almost always its last one, and a head-truncated log of a build ends three
 *  thousand lines before the error. */
const MAX_OUTPUT_CHARS = 16_000;

/** Runs kept per job. Older ones are pruned as new ones are written — this is
 *  a history for answering "did it run last night", not an archive. */
const KEEP_RUNS = 20;

/** Jobs started per sweep. A sweep that is due fifty jobs starts ten and
 *  leaves forty for a minute's time, because fifty containers at once is the
 *  same machine-ending event whether a person or a schedule asked for it. */
const SWEEP_BATCH = 10;

const MAX_NAME = 80;
const MAX_COMMAND = 2000;

export interface JobRow {
  id: string;
  projectId: string;
  name: string;
  schedule: string;
  command: string;
  enabled: boolean;
  nextRunAt: Date | null;
  createdAt: Date;
}

export interface RunRow {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: string;
  exitCode: number | null;
  output: string | null;
}

function toApiRun(row: RunRow): ApiRun {
  return {
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    status: row.status as ApiRun["status"],
    exitCode: row.exitCode,
    output: row.output,
  };
}

function toApiJob(row: JobRow & { runs?: RunRow[] }): ApiJob {
  const last = row.runs?.[0];

  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    schedule: row.schedule,
    command: row.command,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    lastRun: last ? toApiRun(last) : null,
  };
}

/** Checks an expression and returns when it would next fire.
 *
 *  Rejects three separate things with three separate messages, because they
 *  are three separate mistakes and telling somebody "invalid schedule" for all
 *  of them means they cannot fix any of them:
 *
 *  - it does not parse — `CronError` already says which field and why;
 *  - it parses and never fires (`0 0 30 2 *`, a date that does not exist);
 *  - it fires more often than this platform will start a container.
 */
export function validateSchedule(expression: string, now = new Date()): Date | null {
  let fields;
  try {
    fields = parseCron(expression);
  } catch (error) {
    if (error instanceof CronError) throw new BadRequestError(error.message, "BAD_SCHEDULE");
    throw error;
  }

  const first = nextRun(fields, now);
  if (!first) {
    throw new BadRequestError(
      "That schedule is valid but never happens — check the day and month.",
      "SCHEDULE_NEVER_FIRES",
    );
  }

  // The gap between the first two firings is the frequency. Reading it off the
  // expression's shape instead would have to special-case every field
  // combination that can produce a one-minute gap; asking the same function
  // the scheduler uses cannot disagree with the scheduler.
  const second = nextRun(fields, first);
  if (second && second.getTime() - first.getTime() < MIN_INTERVAL_MINUTES * 60 * 1000) {
    throw new BadRequestError(
      `A job may run at most once every ${String(MIN_INTERVAL_MINUTES)} minutes.`,
      "SCHEDULE_TOO_FREQUENT",
    );
  }

  return first;
}

function cleanName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) throw new BadRequestError("Name the job.", "NAME_REQUIRED");
  if (name.length > MAX_NAME) {
    throw new BadRequestError("That name is too long.", "NAME_TOO_LONG");
  }
  return name;
}

function cleanCommand(raw: string): string {
  const command = raw.trim();
  if (command.length === 0) {
    throw new BadRequestError("Give it something to run.", "COMMAND_REQUIRED");
  }
  if (command.length > MAX_COMMAND) {
    throw new BadRequestError("That command is too long.", "COMMAND_TOO_LONG");
  }
  return command;
}

export interface JobInput {
  name: string;
  schedule: string;
  command: string;
  enabled?: boolean;
}

export async function listJobs(projectId: string): Promise<ApiJob[]> {
  const rows = await prisma.scheduledJob.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
    include: { runs: { orderBy: { startedAt: "desc" }, take: 1 } },
  });

  return rows.map(toApiJob);
}

export async function createJob(
  projectId: string,
  input: JobInput,
  now = new Date(),
): Promise<ApiJob> {
  await assertFeature(projectId, "scheduledJobs");

  const name = cleanName(input.name);
  const command = cleanCommand(input.command);
  const enabled = input.enabled ?? true;
  const nextRunAt = validateSchedule(input.schedule, now);

  const existing = await prisma.scheduledJob.count({ where: { projectId } });
  if (existing >= MAX_JOBS_PER_PROJECT) {
    throw new ConflictError(
      `A project may have ${String(MAX_JOBS_PER_PROJECT)} scheduled jobs.`,
      "TOO_MANY_JOBS",
    );
  }

  const row = await prisma.scheduledJob.create({
    data: {
      projectId,
      name,
      schedule: input.schedule.trim(),
      command,
      enabled,
      // A disabled job has no next firing, and storing one anyway would mean
      // the sweeper's index is the only thing standing between a disabled job
      // and a run. Two guards where one is enough is one guard that can be
      // forgotten.
      nextRunAt: enabled ? nextRunAt : null,
    },
  });

  increment("jobs_created");
  return toApiJob(row);
}

export async function updateJob(
  projectId: string,
  jobId: string,
  input: Partial<JobInput>,
  now = new Date(),
): Promise<ApiJob> {
  // Scoped by BOTH, like `deleteJob` and `listRuns` beside it. Looking a job
  // up by id alone let an owner of any project edit any job on the machine by
  // guessing its id -- and the field that matters is `command`, so the reward
  // was making somebody else's container run whatever you liked, on their
  // schedule, under their name. `runJobController` says this in a comment; the
  // one function that did not do it was this one.
  const job = await prisma.scheduledJob.findFirst({ where: { id: jobId, projectId } });
  if (!job) throw new NotFoundError("No such job.", "JOB_NOT_FOUND");

  const schedule = input.schedule?.trim() ?? job.schedule;
  const enabled = input.enabled ?? job.enabled;

  // Re-derived on every update, not only when the expression changed: enabling
  // a job whose stored firing is months in the past must not make it instantly
  // due, and that is exactly what carrying the old value forward would do.
  const nextRunAt = enabled ? validateSchedule(schedule, now) : null;

  const row = await prisma.scheduledJob.update({
    where: { id: jobId },
    data: {
      ...(input.name !== undefined ? { name: cleanName(input.name) } : {}),
      ...(input.command !== undefined ? { command: cleanCommand(input.command) } : {}),
      schedule,
      enabled,
      nextRunAt,
    },
    include: { runs: { orderBy: { startedAt: "desc" }, take: 1 } },
  });

  return toApiJob(row);
}

export async function deleteJob(projectId: string, jobId: string): Promise<void> {
  const { count } = await prisma.scheduledJob.deleteMany({
    where: { id: jobId, projectId },
  });

  if (count === 0) throw new NotFoundError("No such job.", "JOB_NOT_FOUND");
}

export async function listRuns(
  projectId: string,
  jobId: string,
): Promise<ApiRun[]> {
  const job = await prisma.scheduledJob.findFirst({
    where: { id: jobId, projectId },
    select: { id: true },
  });
  if (!job) throw new NotFoundError("No such job.", "JOB_NOT_FOUND");

  const rows = await prisma.scheduledRun.findMany({
    where: { jobId },
    orderBy: { startedAt: "desc" },
    take: KEEP_RUNS,
  });

  return rows.map(toApiRun);
}

function tail(text: string): string {
  return text.length <= MAX_OUTPUT_CHARS
    ? text
    : `… truncated …\n${text.slice(text.length - MAX_OUTPUT_CHARS)}`;
}

/** Waits for a run, or gives up on it.
 *
 *  Resolves rather than rejects on the timeout so the caller writes one row
 *  either way — a run that timed out is a result, not an exception. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve("timeout");
    }, ms);
    // Never hold the process open for a run nobody is waiting on.
    timer.unref?.();

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        // Rejection is PASSED ON, not folded into "timeout". This used to
        // resolve "timeout" here, which meant an exec that threw -- the daemon
        // dropping the connection, the container disappearing underneath it --
        // was recorded as TIMED_OUT and told the owner their command "may
        // still be running inside the container". It was not running anywhere.
        //
        // That collapsed exactly the distinction the six run states exist to
        // draw, and left ERRORED reachable only when `ensureContainer` threw.
        // The caller's catch is what turns this into ERRORED.
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function prune(jobId: string): Promise<void> {
  const keep = await prisma.scheduledRun.findMany({
    where: { jobId },
    orderBy: { startedAt: "desc" },
    take: KEEP_RUNS,
    select: { id: true },
  });

  await prisma.scheduledRun.deleteMany({
    where: { jobId, id: { notIn: keep.map((row) => row.id) } },
  });
}

/** Executes one job now, whatever its schedule says.
 *
 *  Shared by the sweeper and by the "run now" button, deliberately: a run the
 *  owner asked for should be visible in the same history, with the same
 *  truncation and the same overlap rule, as one the clock asked for. A
 *  separate path for manual runs is a second implementation of the only part
 *  anybody actually debugs.
 */
export async function runJobNow(jobId: string): Promise<ApiRun> {
  const job = await prisma.scheduledJob.findUnique({
    where: { id: jobId },
    include: { project: { select: { takenDownAt: true } } },
  });
  if (!job) throw new NotFoundError("No such job.", "JOB_NOT_FOUND");

  // The sweeper already filters these out, so this only catches the "run now"
  // button -- but it is the same rule and it belongs beside the run, not in
  // one of the two callers. A takedown that stops a project being read while
  // this machine goes on executing its command on a schedule has stopped the
  // wrong half.
  if (job.project.takenDownAt) {
    throw new ForbiddenError(
      "A moderator took this project down after a report. Its jobs are held " +
        "until that is lifted.",
      "TAKEN_DOWN",
    );
  }

  const inFlight = await prisma.scheduledRun.findFirst({
    where: { jobId, status: "RUNNING" },
    select: { id: true },
  });

  if (inFlight) {
    const skipped = await prisma.scheduledRun.create({
      data: {
        jobId,
        status: "SKIPPED",
        finishedAt: new Date(),
        output: "The previous run had not finished.",
      },
    });
    increment("jobs_skipped");
    return toApiRun(skipped);
  }

  // Read BEFORE this run exists, because the announcement below is about a
  // change and needs the state that is about to be replaced.
  const previous = await lastVerdict(jobId);

  const run = await prisma.scheduledRun.create({ data: { jobId, status: "RUNNING" } });
  increment("jobs_started");

  let status: ApiRun["status"] = "ERRORED";
  let exitCode: number | null = null;
  let output = "";

  try {
    const container = await ensureContainer(job.projectId);

    // A shell, on purpose. The container is the security boundary — whoever
    // wrote this command already has a terminal in the same one — so argv
    // splitting here would buy nothing and break every honest `a && b`.
    const result = await withTimeout(
      execCapture(container, ["/bin/sh", "-lc", job.command]),
      RUN_TIMEOUT_MS,
    );

    if (result === "timeout") {
      status = "TIMED_OUT";
      output =
        `Gave up after ${String(RUN_TIMEOUT_MS / 60000)} minutes. The command ` +
        `may still be running inside the container.`;
    } else {
      exitCode = result.exitCode;
      status = result.exitCode === 0 ? "SUCCEEDED" : "FAILED";
      output = [result.stdout, result.stderr].filter((part) => part.length > 0).join("\n");
    }
  } catch (error) {
    // Docker down, capacity full, no working tree. The job is fine; the
    // machine could not run it, and that is a different sentence than "your
    // command failed" — which is why ERRORED is not FAILED.
    status = "ERRORED";
    output = error instanceof Error ? error.message : "Could not start the job.";
    logger.error("scheduled job could not start", error, {
      jobId,
      projectId: job.projectId,
    });
  }

  if (status === "SUCCEEDED") increment("jobs_succeeded");
  else increment("jobs_failed");

  const finished = await prisma.scheduledRun.update({
    where: { id: run.id },
    data: { status, exitCode, finishedAt: new Date(), output: tail(output) },
  });

  await prune(jobId);
  await announce(job, previous, status);

  return toApiRun(finished);
}

/** Statuses that say something about the COMMAND.
 *
 *  `SKIPPED` means the job did not run, and `ERRORED` means the machine could
 *  not run it -- neither is a verdict on what the command does, so neither
 *  starts a failure and neither ends one. A week of Docker being down must not
 *  read as a week of the backup being broken, and must not silently cancel the
 *  fact that it was broken before.
 */
type Verdict = "SUCCEEDED" | "FAILED" | "TIMED_OUT";

function isVerdict(status: ApiRun["status"]): status is Verdict {
  return status === "SUCCEEDED" || status === "FAILED" || status === "TIMED_OUT";
}

/** The last thing this job said about its command, or null if it has never
 *  said anything. */
async function lastVerdict(jobId: string): Promise<Verdict | null> {
  const row = await prisma.scheduledRun.findFirst({
    where: { jobId, status: { in: ["SUCCEEDED", "FAILED", "TIMED_OUT"] } },
    orderBy: { startedAt: "desc" },
    select: { status: true },
  });

  return row ? (row.status as Verdict) : null;
}

/** Tells the owner when a job CHANGES state, and only then.
 *
 *  This is the whole point of the feature and the easiest part to get wrong. A
 *  job that fails every night for a month is one piece of news, not thirty:
 *  mailing every failure is how a notification people needed becomes a filter
 *  rule, which restores the silence it was built to end and hides that it has.
 *  So the second consecutive failure says nothing, and the recovery speaks.
 *
 *  A first-ever run that fails does notify. There is no previous verdict to
 *  change from, but somebody has just set this up and it does not work, which
 *  is the most useful moment there is to say so.
 */
async function announce(
  job: { id: string; name: string; projectId: string },
  previous: Verdict | null,
  now: ApiRun["status"],
): Promise<void> {
  if (!isVerdict(now)) return;

  const broke = now !== "SUCCEEDED" && previous !== "FAILED" && previous !== "TIMED_OUT";
  const fixed = now === "SUCCEEDED" && (previous === "FAILED" || previous === "TIMED_OUT");
  if (!broke && !fixed) return;

  const project = await prisma.project.findUnique({
    where: { id: job.projectId },
    select: { ownerId: true, name: true },
  });
  if (!project) return;

  const link = `/project/${job.projectId}?view=jobs`;

  if (fixed) {
    await notify({
      userId: project.ownerId,
      kind: "JOB_RECOVERED",
      title: `"${job.name}" is working again`,
      body:
        `The scheduled job "${job.name}" in ${project.name} succeeded on its ` +
        `latest run, after failing.`,
      link,
    });
    return;
  }

  await notify({
    userId: project.ownerId,
    kind: "JOB_FAILING",
    title: `"${job.name}" is failing`,
    body:
      now === "TIMED_OUT"
        ? `The scheduled job "${job.name}" in ${project.name} ran out of time ` +
          `and was given up on. You will not be told again until it changes.`
        : `The scheduled job "${job.name}" in ${project.name} exited non-zero. ` +
          `You will not be told again until it changes.`,
    link,
  });
}

/** Starts every job that is due, and re-arms it.
 *
 *  `nextRunAt` is advanced BEFORE the run starts, from `now` rather than from
 *  the slot that was missed. Both halves matter: advancing first means a run
 *  that takes longer than its own interval cannot be picked up again by the
 *  next sweep while it is still going, and advancing from `now` is what turns
 *  a day of downtime into one catch-up run instead of a day's worth at once.
 *
 *  `finished` settles when every run this sweep started has been recorded. The
 *  sweeper itself does not wait for it — a job that takes four minutes must not
 *  hold up the next minute's sweep — but a caller that needs to know, a test or
 *  a shutdown, has something to await instead of a sleep.
 */
export async function runDueJobs(now = new Date()): Promise<{
  started: number;
  finished: Promise<void>;
}> {
  // The takedown is in the WHERE and the row is left untouched, which is what
  // makes this "held" rather than "cancelled": the schedule survives, so a
  // reinstatement brings the job back. `nextRunAt` is therefore not advanced
  // while a project is down, and the existing catch-up rule then does the
  // right thing by itself -- one run when it returns, not one per night
  // missed. This clause is the only thing between a project taken down for
  // MALWARE and its command running here every night indefinitely, which no
  // screen in this product would ever have shown.
  const due = await prisma.scheduledJob.findMany({
    where: {
      enabled: true,
      nextRunAt: { not: null, lte: now },
      project: { takenDownAt: null },
    },
    orderBy: { nextRunAt: "asc" },
    take: SWEEP_BATCH,
  });

  let started = 0;
  const pending: Promise<void>[] = [];

  for (const job of due) {
    let nextRunAt: Date | null = null;
    try {
      nextRunAt = nextRunOf(job.schedule, now);
    } catch {
      // The expression validated when it was saved, so reaching here means the
      // row was edited outside the API. Disable rather than retry it every
      // minute forever.
      logger.warn("disabling a scheduled job whose expression no longer parses", {
        jobId: job.id,
      });
    }

    const { count } = await prisma.scheduledJob.updateMany({
      // The stored firing is part of the WHERE, so two servers sweeping the
      // same database cannot both claim the same job: the second update
      // matches nothing and its run never starts.
      where: { id: job.id, nextRunAt: job.nextRunAt },
      data: { nextRunAt, enabled: nextRunAt !== null && job.enabled },
    });

    if (count === 0) continue;

    started += 1;
    pending.push(
      runJobNow(job.id).then(
        () => undefined,
        (error: unknown) => {
          logger.error("scheduled run failed outright", error, { jobId: job.id });
        },
      ),
    );
  }

  return { started, finished: Promise.all(pending).then(() => undefined) };
}
