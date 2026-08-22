import type { Duplex } from "node:stream";
import type { Exec } from "dockerode";
import type { RunState } from "@replit-clone/shared";
import {
  ensureContainer,
  getPreviewTarget,
  getRunningContainer,
} from "./containerManager.js";
import { execCapture } from "./execCapture.js";
import { isServing } from "./devServerProbe.js";
import { getTemplate } from "../templates/registry.js";
import { env, watchPollingEnv } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import {
  isResumable,
  reconcileDecision,
} from "./runReconciliation.js";

/** How much output to retain per project so a client that connects late (or
 *  reconnects) can rebuild the log pane. Bounded so a chatty dev server cannot
 *  grow this without limit. */
const MAX_HISTORY_CHUNKS = 500;

/** How often to probe the dev port while in `starting`. */
const READY_POLL_MS = 1000;

/** Give up promoting `starting` -> `running` after this long. The command keeps
 *  running; we simply stop probing, because some templates (a plain script, a
 *  test run) never listen on a port at all. */
const READY_TIMEOUT_MS = 3 * 60 * 1000;

export interface RunSession {
  state: RunState;
  history: string[];
  stream?: Duplex;
  exec?: Exec;
  readyTimer?: NodeJS.Timeout;
  readyDeadline?: number;
  /** Process group the run was started in; see startRun. */
  pgid?: string;
  /** Output held back while the process group id's marker line is still
   *  potentially incomplete. */
  pgidBuffer?: string;
  /** Set once an automatic start has been attempted for this project, and by
   *  an explicit stop. See `autoStartRun`. */
  autoStartSpent?: boolean;
  /** True once this run reached `running` — i.e. the dev server really worked
   *  before it died. Only such a run is worth an automatic restart after its
   *  death: one that never became ready fails for a reason, and restarting it
   *  would just repeat the failure. */
  everReady?: boolean;
  /** When the run exited, so the restart path can keep its distance from a
   *  crash that just happened. */
  exitedAt?: number;
}

const sessions = new Map<string, RunSession>();

/** Prefix the launcher prints the run's process group id behind.
 *
 *  Printable, because it travels as a shell argument — a NUL would truncate it
 *  — and distinctive enough that build output cannot be mistaken for it. It is
 *  stripped from the log before the user ever sees it. */
export const PGID_MARKER = "__rc_pgid__:";

const PGID_PATTERN = new RegExp(`${PGID_MARKER}(\\d+)\\r?\\n`);

/** How much output to hold while waiting for the marker line. It is the first
 *  thing the launcher writes, so this only ever covers a chunk boundary. */
const PGID_BUFFER_LIMIT = 4096;

/** Where the launcher also records its process group id, inside the container.
 *
 *  The marker on stdout is enough while this process is the one watching the
 *  stream. It is not enough across a server restart: the run keeps going, but
 *  the only record of how to stop it lived in this process's memory. Writing it
 *  where the run itself lives is what lets a restarted server take the run back
 *  over rather than leaving an unstoppable dev server holding the port.
 */
export const PGID_FILE = "/tmp/rc-run.pgid";

/** Reads a process group id out of a marker line.
 *
 *  Separate from `takeProcessGroupId`, which is a streaming parser that also
 *  has to hold output back. This one is handed a complete, tiny reply. */
export function parsePgidReport(text: string): string | undefined {
  return new RegExp(`${PGID_MARKER}(\\d+)`).exec(text)?.[1];
}

/** Wraps a string as a single-quoted shell word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Takes the marker line out of the stream, returning what is left to display.
 *
 *  Buffered rather than matched per chunk: the marker could in principle be
 *  split across two reads, and losing it would leave the run with no way to be
 *  stopped.
 */
export function takeProcessGroupId(
  current: RunSession,
  text: string,
): string {
  if (current.pgid !== undefined) return text;

  const buffered = (current.pgidBuffer ?? "") + text;
  const match = PGID_PATTERN.exec(buffered);

  if (match) {
    current.pgid = match[1];
    current.pgidBuffer = undefined;
    return buffered.replace(match[0], "");
  }

  // Still might be mid-marker. Give up once it is clear it is not coming, and
  // release what was held so the user is not staring at an empty log.
  if (buffered.length > PGID_BUFFER_LIMIT) {
    current.pgidBuffer = undefined;
    return buffered;
  }

  current.pgidBuffer = buffered;
  return "";
}

type Listener = (event: RunEvent) => void;

export type RunEvent =
  | { type: "state"; state: RunState }
  | { type: "output"; chunk: string }
  // The dev server just started answering, so the preview is worth loading.
  // Without this the pane sat on whatever it had until the user pressed
  // reload, with nothing telling them when to.
  | { type: "ready"; port: number };

/** Subscribers are per project, not per socket, so every tab watching the same
 *  project sees the same log and status. */
const listeners = new Map<string, Set<Listener>>();

export function subscribe(projectId: string, listener: Listener): () => void {
  const set = listeners.get(projectId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(projectId, set);

  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(projectId);
  };
}

function emit(projectId: string, event: RunEvent): void {
  listeners.get(projectId)?.forEach((listener) => {
    listener(event);
  });
}

function session(projectId: string): RunSession {
  const existing = sessions.get(projectId);
  if (existing) return existing;

  const created: RunSession = { state: { status: "idle" }, history: [] };
  sessions.set(projectId, created);
  return created;
}

export function getRunState(projectId: string): RunState {
  return session(projectId).state;
}

export function getRunHistory(projectId: string): string[] {
  return session(projectId).history;
}

function setState(projectId: string, state: RunState): void {
  session(projectId).state = state;
  emit(projectId, { type: "state", state });
}

function pushOutput(projectId: string, chunk: string): void {
  const current = session(projectId);
  current.history.push(chunk);
  if (current.history.length > MAX_HISTORY_CHUNKS) current.history.shift();
  emit(projectId, { type: "output", chunk });
}

/** Whether the project's dev server is actually serving.
 *
 *  The preview proxy's own "is there a target" check only says the container is
 *  up, which is true from the moment it starts -- long before `npm install` has
 *  finished and anything has bound the port. Nor is a TCP connection enough to
 *  tell the difference: see devServerProbe.ts, which is where that distinction
 *  now lives. */
async function isListening(projectId: string): Promise<boolean> {
  const target = await getPreviewTarget(projectId).catch(() => undefined);
  if (!target) return false;

  return isServing(target);
}

function stopProbing(current: RunSession): void {
  if (current.readyTimer) clearInterval(current.readyTimer);
  current.readyTimer = undefined;
}

/** Polls until the dev server answers, then promotes the state to `running`. */
function probeUntilReady(projectId: string): void {
  const current = session(projectId);
  stopProbing(current);

  current.readyDeadline = Date.now() + READY_TIMEOUT_MS;
  current.readyTimer = setInterval(() => {
    void (async () => {
      const live = sessions.get(projectId);
      if (!live || live.state.status !== "starting") {
        if (live) stopProbing(live);
        return;
      }

      if (Date.now() > (live.readyDeadline ?? 0)) {
        stopProbing(live);
        return;
      }

      if (await isListening(projectId)) {
        stopProbing(live);
        live.everReady = true;
        setState(projectId, { status: "running", command: live.state.command });

        const template = await templateForProject(projectId).catch(
          () => undefined,
        );
        if (template) {
          emit(projectId, { type: "ready", port: template.devPort });
        }
      }
    })();
  }, READY_POLL_MS);

  current.readyTimer.unref();
}

async function templateForProject(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  return getTemplate(project?.template ?? "react-vite");
}

/** Runs the template's start command inside the project's container.
 *
 *  This is what the Run button drives. The command already existed in the
 *  template registry and was injected into terminals as $START_COMMAND, but
 *  nothing ever ran it -- the user had to know to type it themselves.
 */
export async function startRun(
  projectId: string,
  options: { auto?: boolean } = {},
): Promise<void> {
  const current = session(projectId);

  // Already going: re-running would leave an orphaned process holding the port.
  if (current.state.status === "starting" || current.state.status === "running") {
    return;
  }

  // Claimed BEFORE the first await. The check above and the `setState` below
  // used to sit either side of two of them, so two Run clicks in the same tick
  // both passed the guard and both started a dev server — the second failing
  // to bind the port, and its output arriving from a process the run state had
  // no record of.
  current.state = { status: "starting", command: "" };

  let container;
  let template;

  try {
    container = await ensureContainer(projectId);
    template = await templateForProject(projectId);
  } catch (error) {
    // The claim has to be given back, or the project can never be run again
    // without a restart.
    setState(projectId, { status: "idle" });
    throw error;
  }

  current.history = [];
  current.pgid = undefined;
  current.pgidBuffer = undefined;
  // A new run has not yet earned anything: readiness is proven again, and the
  // clock for "how long ago did it die" starts over if it dies.
  current.everReady = false;
  current.exitedAt = undefined;
  // Running it on purpose re-arms the automatic start, so a stop followed by a
  // run leaves the project behaving like one that was never stopped.
  //
  // Conditional because autoStartRun is itself a caller and clearing the flag
  // for it would contradict the suppression it just set. Today that is belt
  // and braces rather than load-bearing — every route back to `idle` goes
  // through stopRun, which sets the flag again — so it is here to keep the
  // flag meaning what its name says, not to fix an observable bug.
  if (!options.auto) current.autoStartSpent = false;
  increment("runs_started");
  logger.info("run started", { projectId, command: template.startCommand });
  setState(projectId, { status: "starting", command: template.startCommand });
  pushOutput(projectId, `$ ${template.startCommand}\r\n`);

  // `setsid` puts the run in a session — and so a process group — of its own,
  // which is what lets stopRun signal exactly what this run started, including
  // the dev server `npm run dev` spawns as a child, and nothing else.
  //
  // The inner shell reports its own `$$` rather than the launcher reporting
  // `$!`: setsid makes that shell the session leader, so its pid IS the group
  // id, whether or not setsid had to fork to get there. `bash -lc` so the
  // command can use the shell operators the registry writes it with.
  const runScript =
    `echo "${PGID_MARKER}$$"; echo $$ > ${PGID_FILE}; ${template.startCommand}`;

  const exec = await container.exec({
    Cmd: [
      "/bin/bash",
      "-lc",
      `setsid /bin/bash -lc ${shellQuote(runScript)} & wait $!`,
    ],
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    // `User` deliberately unset: Docker then inherits the container's own user,
    // which containerManager matched to the bind mount's owner. Naming a uid
    // here again is how the two drift apart.
    WorkingDir: "/home/sandbox/app",
    Env: [
      "TERM=xterm-256color",
      "FORCE_COLOR=1",
      `DEV_PORT=${String(template.devPort)}`,
      `PREVIEW_BASE=/preview/${projectId}/`,
      // Empty unless the host's bind mount swallows inotify, in which case
      // nothing here would ever notice a saved file. See fileWatching.ts.
      ...watchPollingEnv,
    ],
  });

  const stream: Duplex = await exec.start({ hijack: true, stdin: false });

  current.exec = exec;
  current.stream = stream;

  // Tty: true means Docker does NOT multiplex the stream, so chunks are raw
  // terminal bytes and need no 8-byte header parsing.
  stream.on("data", (chunk: Buffer) => {
    const visible = takeProcessGroupId(current, chunk.toString("utf8"));
    if (visible) pushOutput(projectId, visible);
  });

  // `end` and `close` both fire on a natural exit, and this used to run for
  // each — emitting the same exited state twice.
  let finished = false;

  const finish = (): void => {
    if (finished) return;
    finished = true;

    void (async () => {
      const live = sessions.get(projectId);
      if (!live || live.state.status === "idle") return;

      stopProbing(live);

      const info = await exec.inspect().catch(() => undefined);
      const exitCode = info?.ExitCode ?? undefined;

      if (exitCode !== undefined && exitCode !== 0) {
        increment("runs_failed");
        logger.warn("run exited non-zero", { projectId, exitCode });
      }

      setState(projectId, {
        status: "exited",
        exitCode,
        command: template.startCommand,
      });
      live.stream = undefined;
      live.exec = undefined;
      live.exitedAt = Date.now();
      // A death re-arms one automatic attempt: `everReady` — which the next
      // run has to earn again from scratch — is what stops this becoming a
      // resurrection loop, not this flag.
      live.autoStartSpent = false;
    })();
  };

  stream.on("end", finish);
  stream.on("close", finish);

  probeUntilReady(projectId);
}

/** Asks the container whether the run this server forgot is still going.
 *
 *  Returns the process group id only if the recorded one names a group that is
 *  still alive, so a file left behind by a run that has since finished — and a
 *  pid that has since been reused by something else — is not mistaken for the
 *  dev server.
 */
async function readLiveProcessGroup(
  container: Parameters<typeof execCapture>[0],
): Promise<string | undefined> {
  const script =
    `p=$(cat ${PGID_FILE} 2>/dev/null || true); ` +
    `if [ -n "$p" ] && kill -0 -"$p" 2>/dev/null; ` +
    `then echo "${PGID_MARKER}$p"; fi`;

  const result = await execCapture(container, ["/bin/sh", "-c", script]).catch(
    () => undefined,
  );

  return result ? parsePgidReport(result.stdout) : undefined;
}

function adoptionNotice(stoppable: boolean): string {
  const found =
    "\r\n\x1b[36mReconnected to the dev server already running in this " +
    "project.\x1b[0m\r\n";

  // Lost with the process that was watching it: Docker keeps no copy of an
  // exec's output, so this is stated rather than left as an empty pane under a
  // "running" badge.
  const noHistory =
    "\x1b[33mIts output from before now is not available.\x1b[0m\r\n";

  // Said plainly rather than left to be discovered by pressing Stop and having
  // nothing happen.
  const unstoppable =
    "\x1b[33mIt also did not report a process group, so Stop cannot signal " +
    "it. Restart the project container to clear it.\x1b[0m\r\n";

  return stoppable ? found + noHistory : found + noHistory + unstoppable;
}

function reclaimedNotice(decision: "lost" | "reclaimed"): string {
  if (decision === "reclaimed") {
    return (
      "\r\n\x1b[33mThis project's container was reclaimed while nobody was " +
      "using it, which stopped the dev server with it. Starting it again." +
      "\x1b[0m\r\n"
    );
  }

  return (
    "\r\n\x1b[33mThe dev server is no longer running, though nothing " +
    "recorded it stopping. Starting it again.\x1b[0m\r\n"
  );
}

/** Puts the run state back in step with what is actually true.
 *
 *  Called when a client opens the project, which is the moment the answer is
 *  wanted and the moment the user will next look. Three things it puts right,
 *  all of which were previously permanent:
 *
 *  - A dev server serving with nothing watching it. The run state lives in this
 *    process's memory while the dev server lives in the container, so restart
 *    the server — a deploy, a crash, `tsx watch` noticing a saved file — and a
 *    running project reads as idle. Reloading the page then made it worse, by
 *    starting a second dev server into a port the first one still held.
 *  - A run the state still calls `running` with nothing behind it. Docker does
 *    not always close a hijacked exec stream when its process dies, so the
 *    handler that records the exit never fires. `running` blocks adoption and
 *    blocks the automatic start, so the project was wedged: every reload showed
 *    "Running" over a dead preview, and only Stop-then-Run cleared it.
 *  - A container reclaimed by the idle reaper, which is not a crash and should
 *    come back by itself when the project is opened again.
 *
 *  What it will not do is recover the output of a run it did not start. That
 *  streamed to a process that is gone and Docker keeps no copy, so the log says
 *  so rather than showing an empty pane under a "running" badge.
 */
export async function reconcileRun(projectId: string): Promise<void> {
  const current = session(projectId);
  const before = current.state.status;

  const container = await getRunningContainer(projectId).catch(() => undefined);

  // Docker's answer, not this process's belief. Holding an exec object proves
  // only that a run was started once, which is precisely the belief that goes
  // stale — and taking it as proof of life is what wedged the project at
  // "Running" with nothing running.
  const execRunning = current.exec
    ? await current.exec
        .inspect()
        .then((info) => info.Running)
        .catch(() => undefined)
    : undefined;

  const listening = container ? await isListening(projectId) : false;

  const decision = reconcileDecision({
    status: before,
    execRunning,
    containerRunning: container !== undefined,
    listening,
  });

  if (decision === "none") return;

  // Re-read after the awaits. `startRun` claims the session synchronously, so a
  // Run pressed while this was asking Docker its questions has already won, and
  // acting on the answers to questions about the previous run would undo it.
  const live = session(projectId);
  if (live.state.status !== before || live.exec !== current.exec) return;

  if (decision === "adopt") {
    await adopt(projectId, live, container, execRunning === true);
    return;
  }

  stopProbing(live);
  live.stream?.destroy();
  live.stream = undefined;
  live.exec = undefined;
  live.pgid = undefined;
  live.pgidBuffer = undefined;

  // The user did not stop this, so the suppression an explicit Stop leaves
  // behind must not be applied to it. `isResumable` is what says so; the state
  // going back to `idle` is what lets `autoStartRun` act on it.
  if (isResumable(decision)) live.autoStartSpent = false;

  logger.info("run reconciled against the container", { projectId, decision });
  pushOutput(projectId, reclaimedNotice(decision));
  setState(projectId, { status: "idle" });
}

/** Records that the project is serving, whoever started it.
 *
 *  `owned` distinguishes the two ways to get here. Usually this process knows
 *  nothing about the run and is taking it over, which is worth saying in the
 *  log because the output before now cannot come with it. But a run this
 *  process started can also arrive here — one that came up after the ready
 *  probe had given up on it — and that is a promotion, not a reunion, so it
 *  says nothing.
 */
async function adopt(
  projectId: string,
  live: RunSession,
  container: Awaited<ReturnType<typeof getRunningContainer>>,
  owned: boolean,
): Promise<void> {
  if (!container) return;

  const template = await templateForProject(projectId).catch(() => undefined);
  if (!template) return;

  const pgid = await readLiveProcessGroup(container);

  // Never traded down: a run this process started already knows its own group
  // from the marker on its stream, and the file could be missing.
  live.pgid = pgid ?? live.pgid;
  live.pgidBuffer = undefined;
  // It is serving, so this run has plainly worked — which is what the restart
  // after a later death is allowed to rely on.
  live.everReady = true;

  if (!owned) {
    logger.info("adopted a dev server that was already running", {
      projectId,
      stoppable: live.pgid !== undefined,
    });
    pushOutput(projectId, adoptionNotice(live.pgid !== undefined));
  }

  setState(projectId, {
    status: "running",
    command: live.state.command ?? template.startCommand,
  });

  // The preview is live this instant, so say so — the pane is otherwise
  // waiting for a `previewReady` that only a fresh start would ever send.
  emit(projectId, { type: "ready", port: template.devPort });
}

/** Starts the dev server because someone opened the project, rather than
 *  because they asked for it.
 *
 *  Every template's start command already begins with its install step
 *  (`npm install && npm run dev`, `pip install -r requirements.txt && ...`),
 *  so this covers dependencies as well as the server itself.
 *
 *  Two situations, and the difference between them is the point:
 *
 *  - `idle`: a project that was never started (or was stopped on purpose, in
 *    which case `stopRun`'s flag suppresses this — a user who stops the dev
 *    server does not get it back because another tab connected).
 *  - `exited`: the dev server died on its own. Opening the project starts it
 *    again, provided that run had genuinely worked first (`everReady` — an
 *    OOM kill of a healthy server is exactly what a refresh should bring
 *    back). A run that never became ready is not restarted at all: it fails
 *    for a reason, and restarting it just repeats the failure — the Run
 *    button is there when the reason is fixed. The cooldown keeps a socket
 *    reconnecting right after a crash from being a restart trigger.
 *
 *  Either way it does not report failure to the client: nobody asked for
 *  this, so a container that cannot start (the per-user cap, most often)
 *  leaves the project sitting where it was with the Run button exactly where
 *  it always was, rather than opening the project onto an error nobody
 *  triggered.
 */

/** How long a run must have been dead before opening the project will start
 *  it again — far enough that a socket reconnecting after a crash is not a
 *  restart trigger, near enough that a human refresh (seconds, not minutes)
 *  always qualifies. */
const RESTART_COOLDOWN_MS = 3_000;

export async function autoStartRun(projectId: string): Promise<void> {
  if (!env.AUTO_START_ON_OPEN) return;

  const current = session(projectId);
  if (current.autoStartSpent) return;

  if (current.state.status === "exited") {
    if (!current.everReady) return;
    if (Date.now() - (current.exitedAt ?? 0) < RESTART_COOLDOWN_MS) return;
    // Falls through to the single start below.
  } else if (current.state.status !== "idle") {
    return;
  }

  // Recorded before anything can await, so the attempt is unambiguous however
  // the rest of this unwinds. Two tabs racing here are actually caught by
  // `startRun`, which claims the state synchronously; this simply means the
  // attempt is already written down by the time that happens.
  current.autoStartSpent = true;

  try {
    await startRun(projectId, { auto: true });
  } catch (error) {
    // Given back, so opening the project again once there is room can try
    // afresh. Leaving it spent would mean the project could never start
    // itself again until the server restarted.
    current.autoStartSpent = false;
    logger.info("automatic start declined", {
      projectId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Stops the run.
 *
 *  Killing the exec's own PID is not enough: `npm run dev` spawns the actual
 *  dev server as a child, and Docker will not reap it. `startRun` therefore
 *  puts the command in a process group of its own, and this signals the whole
 *  group — which is exactly what the run started, and nothing else.
 *
 *  The previous approach, `pkill -f 'npm|node|vite|next|python|serve'`, killed
 *  every Node and Python process in the container no matter which shell had
 *  started it. Because `pkill -f` matches whole command lines, and that pattern
 *  contains the word "node", it also matched the very shell running it. Its
 *  `fuser` fallback never did anything either: neither sandbox image installs
 *  psmisc.
 */
export async function stopRun(projectId: string): Promise<void> {
  // `session` rather than `sessions.get`: stopping a project with no session
  // yet still has to record that stopping is what the user wanted, or opening
  // it again would start the very server they just asked to be rid of.
  const current = session(projectId);

  // An explicit stop outranks any later automatic start. Cleared by startRun,
  // so the Run button still works normally afterwards.
  current.autoStartSpent = true;

  stopProbing(current);

  const { pgid } = current;

  if (!pgid) {
    // The marker never arrived, so there is no process group to signal. The
    // old code ran `true` here, reported "Stopped." and set the state to idle
    // — while the dev server carried on holding the port, which then made the
    // next Run look broken for no visible reason.
    stopProbing(current);
    logger.warn("cannot stop the run: no process group was captured", { projectId });
    pushOutput(
      projectId,
      "\r\n\x1b[31mCould not stop the dev server: its process group was never " +
        "reported. Restart the project container to clear it.\x1b[0m\r\n",
    );
    return;
  }

  try {
    const container = await ensureContainer(projectId);

    // SIGTERM first so a dev server can close its port cleanly, then SIGKILL
    // for anything still up. `|| true` so a group that has already exited is
    // not an error.
    const killer = await container.exec({
      Cmd: [
        "/bin/bash",
        "-lc",
        `kill -TERM -${pgid} 2>/dev/null || true; ` +
          `sleep 1; kill -KILL -${pgid} 2>/dev/null || true`,
      ],
      AttachStdout: false,
      AttachStderr: false,
    });
    // Destroyed rather than dropped: dockerode returns a stream whatever the
    // attach flags say, and each stop used to leave one behind.
    const killStream = await killer.start({ hijack: false, stdin: false });
    killStream.destroy();
  } catch {
    // Container already gone: nothing to stop.
  }

  current.stream?.destroy();
  current.stream = undefined;
  current.exec = undefined;
  current.pgid = undefined;
  current.pgidBuffer = undefined;

  setState(projectId, { status: "idle" });
  pushOutput(projectId, "\r\n\x1b[33mStopped.\x1b[0m\r\n");
}

/** Stops the run and starts it again.
 *
 *  Restarting used to mean pressing Stop, waiting, and pressing Run — and
 *  pressing Run too early silently did nothing, because startRun returns early
 *  while the previous run is still shutting down.
 */
export async function restartRun(projectId: string): Promise<void> {
  await stopRun(projectId);

  // stopRun signals the group and returns; the processes take a moment to go.
  // Starting into a port that is not yet free is the failure this avoids.
  await waitForPortRelease(projectId);

  await startRun(projectId);
}

/** Waits for the dev port to stop answering, up to a bounded time. */
async function waitForPortRelease(projectId: string): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (!(await isListening(projectId))) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  logger.warn("dev port still held after stop; starting anyway", { projectId });
}

/** Drops all state for a project, e.g. when it is deleted. */
export function forgetRun(projectId: string): void {
  const current = sessions.get(projectId);
  if (current) stopProbing(current);
  sessions.delete(projectId);
  listeners.delete(projectId);
}
