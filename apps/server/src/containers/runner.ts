import net from "node:net";
import type { Duplex } from "node:stream";
import type { Exec } from "dockerode";
import type { RunState } from "@replit-clone/shared";
import { ensureContainer, getPreviewTarget } from "./containerManager.js";
import { getTemplate } from "../templates/registry.js";
import { prisma } from "../lib/prisma.js";

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
  | { type: "output"; chunk: string };

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

/** Opens a TCP connection to the dev server to decide whether it is actually
 *  listening.
 *
 *  The preview proxy's own "is there a target" check only tells us the
 *  container is up, which is true the moment it starts -- long before `npm
 *  install` has finished and the dev server has bound its port. */
async function isListening(projectId: string): Promise<boolean> {
  const target = await getPreviewTarget(projectId).catch(() => undefined);
  if (!target) return false;

  const { hostname, port } = new URL(target);

  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port: Number(port) });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(750);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
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
        setState(projectId, { status: "running", command: live.state.command });
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
export async function startRun(projectId: string): Promise<void> {
  const current = session(projectId);

  // Already going: re-running would leave an orphaned process holding the port.
  if (current.state.status === "starting" || current.state.status === "running") {
    return;
  }

  const container = await ensureContainer(projectId);
  const template = await templateForProject(projectId);

  current.history = [];
  current.pgid = undefined;
  current.pgidBuffer = undefined;
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
  const runScript = `echo "${PGID_MARKER}$$"; ${template.startCommand}`;
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
    ],
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  current.exec = exec;
  current.stream = stream as unknown as Duplex;

  // Tty: true means Docker does NOT multiplex the stream, so chunks are raw
  // terminal bytes and need no 8-byte header parsing.
  (stream as unknown as Duplex).on("data", (chunk: Buffer) => {
    const visible = takeProcessGroupId(current, chunk.toString("utf8"));
    if (visible) pushOutput(projectId, visible);
  });

  const finish = (): void => {
    void (async () => {
      const live = sessions.get(projectId);
      if (!live || live.state.status === "idle") return;

      stopProbing(live);

      const info = await exec.inspect().catch(() => undefined);
      setState(projectId, {
        status: "exited",
        exitCode: info?.ExitCode ?? undefined,
        command: template.startCommand,
      });
      live.stream = undefined;
      live.exec = undefined;
    })();
  };

  (stream as unknown as Duplex).on("end", finish);
  (stream as unknown as Duplex).on("close", finish);

  probeUntilReady(projectId);
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
  const current = sessions.get(projectId);
  if (!current) return;

  stopProbing(current);

  const { pgid } = current;

  try {
    const container = await ensureContainer(projectId);

    // SIGTERM first so a dev server can close its port cleanly, then SIGKILL
    // for anything still up. `|| true` so a group that has already exited is
    // not an error.
    const killer = await container.exec({
      Cmd: [
        "/bin/bash",
        "-lc",
        pgid
          ? `kill -TERM -${pgid} 2>/dev/null || true; ` +
            `sleep 1; kill -KILL -${pgid} 2>/dev/null || true`
          : "true",
      ],
      AttachStdout: false,
      AttachStderr: false,
    });
    await killer.start({ hijack: false, stdin: false });
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

/** Drops all state for a project, e.g. when it is deleted. */
export function forgetRun(projectId: string): void {
  const current = sessions.get(projectId);
  if (current) stopProbing(current);
  sessions.delete(projectId);
  listeners.delete(projectId);
}
