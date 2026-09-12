import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Container } from "dockerode";
import type { WebSocket } from "ws";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../config/env.js", () => ({
  watchPollingEnv: [],
  env: {
    TERMINAL_SCROLLBACK_BYTES: 64 * 1024,
    TERMINAL_DETACH_GRACE_SECONDS: 1800,
    TERMINAL_MAX_SESSIONS_PER_PROJECT: 8,
  },
}));
vi.mock("../templates/registry.js", () => ({
  getTemplate: () => ({ devPort: 3000, startCommand: "npm run dev" }),
}));

import {
  bindSocketToSession,
  handleTerminalCreation,
} from "./handleTerminalCreation.js";
import {
  endSession,
  findSession,
  resetSessionsForTest,
} from "../terminal/terminalSessions.js";

const TERMINAL_ID = 7;

/** Enough of a WebSocket for the shell to attach to, with a readyState that
 *  can be moved the way a departing client moves it. */
/** The exec that opens the shell.
 *
 *  Matched on the joined command rather than on array membership since §10.14:
 *  the wrapper is `/bin/sh -c "... exec <shell>"`, so `/bin/bash` is now part
 *  of the script rather than an argv entry of its own. The shell is
 *  configurable, so this looks for the wrapper's shape and not for bash.
 */
function isShellExec(cmd: string[]): boolean {
  return cmd[0] === "/bin/sh" && (cmd[2] ?? "").includes("exec /");
}

function fakeSocket(readyState = 1) {
  const handlers = new Map<string, (() => void)[]>();

  const ws = {
    OPEN: 1,
    readyState,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
    on(event: string, handler: () => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  };

  /** Closes the socket the way `ws` does: state first, then the listeners. */
  const closeFromClient = (): void => {
    ws.readyState = 3;
    for (const handler of handlers.get("close") ?? []) handler();
  };

  return { ws: ws as unknown as WebSocket, raw: ws, closeFromClient };
}

interface ExecCall {
  /** The exec's environment, which is where $START_COMMAND is handed over. */
  env: string[];
  cmd: string[];
  started: boolean;
}

/** A container whose exec creation and start are both resolved by hand, so a
 *  client can leave in either of the two windows Docker leaves open. */
function fakeContainer() {
  const stream = new PassThrough();
  const calls: ExecCall[] = [];
  let finishCreate: (() => void) | undefined;
  let finishStart: (() => void) | undefined;

  const container = {
    exec(
      opts: { Cmd: string[]; Env?: string[] },
      cb?: (err: Error | null, exec?: unknown) => void,
    ) {
      const call: ExecCall = {
        cmd: opts.Cmd,
        env: opts.Env ?? [],
        started: false,
      };
      calls.push(call);

      const exec = {
        start(
          _startOpts: unknown,
          startCb?: (err: Error | null, stream?: PassThrough) => void,
        ) {
          call.started = true;
          if (!startCb) return Promise.resolve(new PassThrough());
          finishStart = () => startCb(null, stream);
          return undefined;
        },
        resize: vi.fn(() => Promise.resolve()),
      };

      // The shell is created with a callback; the hangup uses the promise form.
      if (!cb) return Promise.resolve(exec);
      finishCreate = () => cb(null, exec);
      return undefined;
    },
  };

  return {
    container: container as unknown as Container,
    stream,
    calls,
    shellStarted: () =>
      calls.some((call) => isShellExec(call.cmd) && call.started),
    create: () => finishCreate?.(),
    start: () => finishStart?.(),
  };
}

const attachInput = () => undefined;

/** The shell's exec, whatever order it was created in — the sweep for orphaned
 *  shells creates one of its own first. */
function shellCall(docker: ReturnType<typeof fakeContainer>): ExecCall | undefined {
  return docker.calls.find((call) => isShellExec(call.cmd));
}

/** The pid file this shell was actually given. Read back rather than rebuilt,
 *  because the nonce in it is not something the test can predict — that is the
 *  whole point of it. */
function pidFileOf(docker: ReturnType<typeof fakeContainer>): string {
  const found = /\/tmp\/rc-term-\d+-[0-9a-f]+\.pid/.exec(
    shellCall(docker)?.cmd.join(" ") ?? "",
  );
  return found?.[0] ?? "no pid file";
}

/** The hangup runs as its own exec; this is how the test spots it. Matched on
 *  the exact file, so the sweep — which globs the id and skips this file — is
 *  never mistaken for it. */
function hangUps(docker: ReturnType<typeof fakeContainer>): ExecCall[] {
  const pidFile = pidFileOf(docker);
  return docker.calls.filter((call) =>
    call.cmd.some(
      (part) => part.includes(`rm -f ${pidFile}`) && part.includes("kill"),
    ),
  );
}

/** The sweep of shells left behind by earlier connections to this id. */
function reclaims(docker: ReturnType<typeof fakeContainer>): ExecCall[] {
  return docker.calls.filter((call) =>
    call.cmd.some(
      (part) =>
        part.includes(`/tmp/rc-term-${String(TERMINAL_ID)}-*.pid`) &&
        part.includes("kill"),
    ),
  );
}

/** A terminal the client did not name, which is what an older web build and a
 *  browser that cannot store a key both send. Nothing can ever ask for its
 *  shell again, so it keeps the pre-§13.7 lifecycle exactly. */
function start(docker: ReturnType<typeof fakeContainer>, ws: WebSocket): void {
  handleTerminalCreation(docker.container, ws, "node", attachInput, TERMINAL_ID);
}

/** A terminal the client named, which is the one a reconnect can come back to.
 *  plan.md §13.7. */
function startSession(
  docker: ReturnType<typeof fakeContainer>,
  ws: WebSocket,
  id = "user-1:project-1:key-abcdefgh",
  release: () => void = () => undefined,
): void {
  handleTerminalCreation(
    docker.container,
    ws,
    "node",
    attachInput,
    TERMINAL_ID,
    undefined,
    { id, projectId: "project-1", release },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionsForTest();
});

describe("handleTerminalCreation", () => {
  it("starts a shell and wires it to a live socket", () => {
    const { ws } = fakeSocket();
    const docker = fakeContainer();

    start(docker, ws);
    docker.create();
    docker.start();

    expect(docker.shellStarted()).toBe(true);
    expect(docker.stream.destroyed).toBe(false);
  });

  /** The shell has to record its own pid, because that is the only handle on
   *  it once the socket is gone. See terminalShell.ts. */
  it("has the shell record its pid where the hangup can find it", () => {
    const { ws } = fakeSocket();
    const docker = fakeContainer();

    start(docker, ws);

    expect(shellCall(docker)?.cmd.join(" ")).toContain(pidFileOf(docker));
  });

  /** Closing the stream does NOT end the exec — measured against a real
   *  container. Without a hangup, every closed terminal left a `/bin/bash`
   *  inside the project's container for as long as the container lived.
   *
   *  §13.7 moved this for terminals the client NAMES; a terminal it does not
   *  name is unreachable the moment its socket goes, so holding it would be
   *  holding a shell for a reconnect that cannot happen. Unchanged on purpose,
   *  and asserted so it stays that way. */
  it("hangs an unnamed shell up when the client disconnects", () => {
    const { ws, closeFromClient } = fakeSocket();
    const docker = fakeContainer();

    start(docker, ws);
    docker.create();
    docker.start();
    closeFromClient();

    expect(hangUps(docker)).toHaveLength(1);
  });

  /** `ws` emits both, and a shell must not be hung up twice — the second call
   *  would land on a pid file that has been removed, or worse, on a pid the
   *  container has since reused. */
  it("hangs an unnamed shell up once, not once per close event", () => {
    const { ws, raw, closeFromClient } = fakeSocket();
    const docker = fakeContainer();

    start(docker, ws);
    docker.create();
    docker.start();
    closeFromClient();
    raw.readyState = 3;
    closeFromClient();

    expect(hangUps(docker)).toHaveLength(1);
  });

  /** Docker answers `exec` well after the request, and the client can be gone
   *  by then. Creating an exec runs nothing, so there is nothing to undo — but
   *  starting one would spawn a shell with nobody on the other end of it. */
  it("starts no shell when the client left before the exec was created", () => {
    const { ws, raw } = fakeSocket();
    const docker = fakeContainer();

    start(docker, ws);
    raw.readyState = 3;
    docker.create();

    expect(docker.shellStarted()).toBe(false);
  });

  /** The other window: everything that tears a shell down hangs off
   *  `ws.on("close")`, registered at the very end of the start callback. A
   *  socket that closed before we got there was never going to be heard. */
  it("ends the shell when the client left while it was starting", () => {
    const { ws, raw } = fakeSocket();
    const docker = fakeContainer();

    start(docker, ws);
    docker.create();
    raw.readyState = 3;
    docker.start();

    expect(docker.stream.destroyed).toBe(true);
    expect(hangUps(docker)).toHaveLength(1);
  });

  /** The bug this exists for. A terminal id is reused, and before the sweep a
   *  reconnect just started a second shell under it: the first one kept
   *  running, kept whatever it had started running with it, and — since the
   *  only record of its pid had been overwritten — could no longer be hung up
   *  by anything. A dev server left that way holds the container's port, and
   *  `npm start` in the new shell answers EADDRINUSE with nothing visible to
   *  blame. */
  it("collects shells left behind by earlier connections to the same terminal", () => {
    const { ws } = fakeSocket();
    const docker = fakeContainer();

    start(docker, ws);

    expect(reclaims(docker)).toHaveLength(1);
  });

  /** The sweep runs while the new shell is still being created, so it must not
   *  be able to take the new shell with it. Excluding it by exact name is what
   *  makes the ordering not matter. */
  it("does not collect the shell it is opening", () => {
    const { ws } = fakeSocket();
    const docker = fakeContainer();

    start(docker, ws);
    docker.create();
    docker.start();

    const script = reclaims(docker)[0]?.cmd.join(" ") ?? "";
    expect(script).toContain(`[ "$f" = "${pidFileOf(docker)}" ] && continue`);
  });

  /** Ports are the reason for the sweep, so it has to happen before the shell
   *  that will be told to bind them — not after, and not on close. */
  it("collects them before opening the new shell", () => {
    const { ws } = fakeSocket();
    const docker = fakeContainer();

    start(docker, ws);

    const sweep = reclaims(docker)[0];
    const shell = shellCall(docker);
    // Asserted, not assumed: `indexOf` on a missing call is -1, which would
    // pass the ordering check below without a sweep ever having happened.
    expect(sweep).toBeDefined();
    expect(shell).toBeDefined();
    expect(docker.calls.indexOf(sweep!)).toBeLessThan(
      docker.calls.indexOf(shell!),
    );
  });

  it("sends nothing to a client that has gone", () => {
    const { ws, raw } = fakeSocket();
    const docker = fakeContainer();

    start(docker, ws);
    docker.create();
    raw.readyState = 3;
    docker.start();
    docker.stream.write("a prompt nobody asked for");

    expect(raw.send).not.toHaveBeenCalled();
  });
});


/** plan.md §13.7. The behaviour this section is about is a single word in
 *  `bindSocketToSession` — `detachSocket` rather than `hangUpShell` — and
 *  everything below is about what that word does and does not change. */
describe("a terminal the client can come back to", () => {
  it("keeps the shell when the socket goes", () => {
    const { ws, closeFromClient } = fakeSocket();
    const docker = fakeContainer();

    startSession(docker, ws);
    docker.create();
    docker.start();
    closeFromClient();

    // The whole point: closing a laptop no longer kills the build.
    expect(hangUps(docker)).toHaveLength(0);
    expect(docker.stream.destroyed).toBe(false);
  });

  it("holds the container's attachment while it is detached", () => {
    const { ws, closeFromClient } = fakeSocket();
    const docker = fakeContainer();
    const release = vi.fn();

    startSession(docker, ws, "user-1:project-1:key-abcdefgh", release);
    docker.create();
    docker.start();
    closeFromClient();

    // A detached session running a build is a real use of that container, and
    // the idle reaper skips projects with attachments — so releasing here
    // would let the reaper stop the container out from under it.
    expect(release).not.toHaveBeenCalled();
  });

  it("is findable by the id the client will ask for", () => {
    const { ws } = fakeSocket();
    const docker = fakeContainer();

    startSession(docker, ws, "user-1:project-1:key-abcdefgh");
    docker.create();
    docker.start();

    expect(findSession("user-1:project-1:key-abcdefgh")).toBeDefined();
  });

  it("holds output produced while nobody is attached", () => {
    const { ws, closeFromClient } = fakeSocket();
    const docker = fakeContainer();

    startSession(docker, ws);
    docker.create();
    docker.start();
    closeFromClient();

    docker.stream.write(Buffer.from("build finished\n"));

    const session = findSession("user-1:project-1:key-abcdefgh");
    expect(session?.scrollback.size).toBeGreaterThan(0);
  });

  it("hands that output back to the socket that reconnects", () => {
    const first = fakeSocket();
    const docker = fakeContainer();

    startSession(docker, first.ws);
    docker.create();
    docker.start();
    first.closeFromClient();

    docker.stream.write(Buffer.from("build finished\n"));

    const second = fakeSocket();
    const session = findSession("user-1:project-1:key-abcdefgh");
    expect(session).toBeDefined();
    bindSocketToSession(session!, second.ws, attachInput);

    // Reattaching to a live pty with a blank pane, and no way to know whether
    // the build finished, would be barely better than a new shell.
    expect(second.raw.send).toHaveBeenCalledWith(
      expect.objectContaining({ length: "build finished\n".length }),
    );
  });

  it("starts no second shell for a reconnect", () => {
    const first = fakeSocket();
    const docker = fakeContainer();

    startSession(docker, first.ws);
    docker.create();
    docker.start();
    first.closeFromClient();

    const shellsBefore = docker.calls.filter((call) =>
      isShellExec(call.cmd),
    ).length;

    const second = fakeSocket();
    bindSocketToSession(findSession("user-1:project-1:key-abcdefgh")!, second.ws, attachInput);

    expect(
      docker.calls.filter((call) => isShellExec(call.cmd)),
    ).toHaveLength(shellsBefore);
  });

  it("ends the session when the shell itself exits", async () => {
    const { ws } = fakeSocket();
    const docker = fakeContainer();
    const release = vi.fn();

    startSession(docker, ws, "user-1:project-1:key-abcdefgh", release);
    docker.create();
    docker.start();

    // The user typed `exit`. There is no pty left to reconnect to, so holding
    // the container for a grace window would be holding it for nothing.
    docker.stream.end();
    // `end` on a stream is emitted after the readable side drains, which is a
    // tick away and not synchronous with `.end()`.
    await vi.waitFor(() =>
      expect(findSession("user-1:project-1:key-abcdefgh")).toBeUndefined(),
    );

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the attachment exactly once when it ends", () => {
    const { ws } = fakeSocket();
    const docker = fakeContainer();
    const release = vi.fn();

    startSession(docker, ws, "user-1:project-1:key-abcdefgh", release);
    docker.create();
    docker.start();

    const session = findSession("user-1:project-1:key-abcdefgh")!;
    endSession(session, "grace-expired");
    endSession(session, "shutdown");

    // Four different things end a session and two can arrive together — a
    // shell that exits while the grace timer is firing. Releasing twice would
    // decrement an attachment belonging to somebody else's editor socket.
    expect(release).toHaveBeenCalledTimes(1);
    expect(hangUps(docker)).toHaveLength(1);
  });

  it("hangs the shell up when the grace window expires", () => {
    const { ws, closeFromClient } = fakeSocket();
    const docker = fakeContainer();

    startSession(docker, ws);
    docker.create();
    docker.start();
    closeFromClient();

    expect(hangUps(docker)).toHaveLength(0);

    // The leak the 2026-09-04 fix closed stays closed. It closes later, not
    // never.
    const session = findSession("user-1:project-1:key-abcdefgh")!;
    endSession(session, "grace-expired");

    expect(hangUps(docker)).toHaveLength(1);
  });
});

describe("the run command a shell is told about", () => {
  /** `$START_COMMAND` is a hint the shell prints. A hint naming a command the
   *  Run button does not run is worse than none. */
  function startCommandIn(override?: string): string | undefined {
    const { ws } = fakeSocket();
    const docker = fakeContainer();

    handleTerminalCreation(
      docker.container,
      ws,
      "node",
      attachInput,
      TERMINAL_ID,
      override,
    );

    return shellCall(docker)?.env
      .find((entry) => entry.startsWith("START_COMMAND="))
      ?.slice("START_COMMAND=".length);
  }

  it("uses the template's when the project has none", () => {
    const command = startCommandIn();
    expect(command).toBeTruthy();
    expect(command).not.toBe("pnpm dev --host");
  });

  it("uses the project's own when it has one", () => {
    expect(startCommandIn("pnpm dev --host")).toBe("pnpm dev --host");
  });

  it("ignores an override that is only whitespace", () => {
    // Which would otherwise leave the shell printing an empty command.
    expect(startCommandIn("   ")?.trim()).toBeTruthy();
  });
});
