import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Container } from "dockerode";
import type { WebSocket } from "ws";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../config/env.js", () => ({ watchPollingEnv: [] }));
vi.mock("../templates/registry.js", () => ({
  getTemplate: () => ({ devPort: 3000, startCommand: "npm run dev" }),
}));

import { handleTerminalCreation } from "./handleTerminalCreation.js";
import { terminalPidFile } from "./terminalShell.js";

const TERMINAL_ID = 7;

/** Enough of a WebSocket for the shell to attach to, with a readyState that
 *  can be moved the way a departing client moves it. */
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
      opts: { Cmd: string[] },
      cb?: (err: Error | null, exec?: unknown) => void,
    ) {
      const call: ExecCall = { cmd: opts.Cmd, started: false };
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
    shellStarted: () => calls.some((call) => call.cmd.includes("/bin/bash") && call.started),
    create: () => finishCreate?.(),
    start: () => finishStart?.(),
  };
}

const attachInput = () => undefined;

/** The hangup runs as its own exec; this is how the test spots it. */
function hangUps(docker: ReturnType<typeof fakeContainer>): ExecCall[] {
  return docker.calls.filter((call) =>
    call.cmd.some((part) => part.includes(terminalPidFile(TERMINAL_ID)) && part.includes("kill")),
  );
}

function start(docker: ReturnType<typeof fakeContainer>, ws: WebSocket): void {
  handleTerminalCreation(docker.container, ws, "node", attachInput, TERMINAL_ID);
}

beforeEach(() => {
  vi.clearAllMocks();
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

    expect(docker.calls[0]?.cmd.join(" ")).toContain(terminalPidFile(TERMINAL_ID));
  });

  /** Closing the stream does NOT end the exec — measured against a real
   *  container. Without a hangup, every closed terminal left a `/bin/bash`
   *  inside the project's container for as long as the container lived. */
  it("hangs the shell up when the client disconnects", () => {
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
  it("hangs the shell up once, not once per close event", () => {
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
