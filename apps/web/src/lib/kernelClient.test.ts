// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelClient, type KernelState } from "./kernelClient.ts";

/** The socket half of a notebook's kernel.
 *
 *  The property worth testing here is the one the whole feature's cost rests
 *  on: **constructing a client connects to nothing.** A kernel is a process in
 *  a container holding whatever the user assigned to a variable, so opening a
 *  notebook to read it must not start one — only Run does.
 */

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;

  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
  }

  /** The server saying something. */
  fire(type: string, event: unknown = {}): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.fire("open");
  }
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(onMessage = vi.fn(), onState = vi.fn()) {
  return {
    instance: new KernelClient("ws://host/kernel", { onMessage, onState }),
    onMessage,
    onState,
  };
}

describe("what opening a notebook costs", () => {
  /** The whole reason `useKernel` does not connect in an effect. */
  it("connects to nothing until something is sent", () => {
    client();

    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("connects on the first execute", () => {
    const { instance } = client();

    instance.send({ type: "execute", cellId: "a", code: "x = 1" });

    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe("the click the user is watching", () => {
  /** Without the queue, clicking Run on a cold notebook loses the very cell
   *  that started the kernel -- the socket is still opening when it is sent. */
  it("sends what was asked for while connecting, once it is open", () => {
    const { instance } = client();

    instance.send({ type: "execute", cellId: "a", code: "x = 1" });
    const socket = FakeSocket.instances[0]!;
    expect(socket.sent).toHaveLength(0);

    socket.open();

    expect(socket.sent).toEqual([
      JSON.stringify({ type: "execute", cellId: "a", code: "x = 1" }),
    ]);
  });

  it("keeps the order of everything queued", () => {
    const { instance } = client();

    instance.send({ type: "execute", cellId: "a", code: "1" });
    instance.send({ type: "execute", cellId: "b", code: "2" });
    FakeSocket.instances[0]!.open();

    const sent = FakeSocket.instances[0]!.sent.map(
      (raw) => JSON.parse(raw) as unknown,
    );
    expect(sent).toEqual([
      { type: "execute", cellId: "a", code: "1" },
      { type: "execute", cellId: "b", code: "2" },
    ]);
  });

  it("opens only one socket however many cells are queued", () => {
    const { instance } = client();

    instance.send({ type: "execute", cellId: "a", code: "1" });
    instance.send({ type: "execute", cellId: "b", code: "2" });

    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe("what it reports", () => {
  it("turns the kernel's own messages into state, and passes them on", () => {
    const states: KernelState[] = [];
    const { instance, onMessage } = client(
      vi.fn(),
      vi.fn((state: KernelState) => states.push(state)),
    );

    instance.send({ type: "execute", cellId: "a", code: "1" });
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.fire("message", {
      data: JSON.stringify({ type: "ready", kernel: "python3", language: "python" }),
    });
    socket.fire("message", {
      data: JSON.stringify({ type: "status", state: "busy" }),
    });

    expect(states).toContain("connecting");
    expect(states).toContain("ready");
    expect(states).toContain("busy");
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  /** The gateway refuses an upgrade by writing a 503 and destroying the
   *  socket, which reaches the browser as a close rather than as a message. */
  it("treats a close as a failure, carrying whatever reason there was", () => {
    const onState = vi.fn();
    const { instance } = client(vi.fn(), onState);

    instance.send({ type: "execute", cellId: "a", code: "1" });
    FakeSocket.instances[0]!.fire("close", { reason: "Not enough memory" });

    expect(onState).toHaveBeenLastCalledWith("failed", "Not enough memory");
  });

  it("survives a message that is not JSON", () => {
    const { instance, onMessage } = client();

    instance.send({ type: "execute", cellId: "a", code: "1" });
    const socket = FakeSocket.instances[0]!;
    socket.open();

    expect(() => socket.fire("message", { data: "<html>503</html>" })).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("a notebook that is closed", () => {
  /** A disposed client that still reported would set state on an unmounted
   *  component, and a queued execute would start a kernel for a tab nobody is
   *  looking at. */
  it("says nothing more and sends nothing more", () => {
    const { instance, onMessage, onState } = client();
    instance.send({ type: "execute", cellId: "a", code: "1" });
    const socket = FakeSocket.instances[0]!;
    socket.open();
    onState.mockClear();

    instance.dispose();
    socket.fire("message", { data: JSON.stringify({ type: "status", state: "busy" }) });
    socket.fire("close", { reason: "gone" });
    instance.send({ type: "execute", cellId: "b", code: "2" });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
