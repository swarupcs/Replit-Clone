// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useLanguageServer } from "./useLanguageServer.ts";
import { useAuthStore } from "../store/authStore.ts";

/** Wiring the language server into the editor.
 *
 *  The server half was verified against real containers -- `pylsp` and
 *  `gopls` both start, initialize, and publish diagnostics with the right
 *  lines and severities. What could not be verified that way is this half:
 *  which files get a connection at all, and what happens to the squiggles
 *  when one goes away.
 */

/** A WebSocket that never touches the network and can be driven from a test. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly sent: string[] = [];
  private listeners = new Map<string, ((event: unknown) => void)[]>();
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closed = true;
  }

  /** Drives the socket's own lifecycle from the test's point of view. */
  emit(type: string, event: unknown = {}): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  open(): void {
    this.emit("open");
  }

  /** One JSON-RPC message, as the gateway delivers it: one per frame. */
  deliver(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  /** Everything this socket has sent, parsed. */
  messages(): { id?: number; method?: string; params?: unknown }[] {
    return this.sent.map(
      (text) => JSON.parse(text) as { id?: number; method?: string },
    );
  }
}

const setModelMarkers = vi.fn();
let contentHandler: (() => void) | null = null;
const disposeContent = vi.fn();

const SOURCE = "print(1)";

function fakeModel() {
  return {
    getValue: () => SOURCE,
    isDisposed: () => false,
    onDidChangeContent: (handler: () => void) => {
      contentHandler = handler;
      return { dispose: disposeContent };
    },
  };
}

function harness(options: {
  language?: string;
  relPath?: string;
  projectId?: string;
}) {
  const model = fakeModel();
  const monaco = { editor: { setModelMarkers } };
  const codeEditor = { getModel: () => model };

  function Probe() {
    useLanguageServer({
      monaco: monaco as never,
      editor: codeEditor as never,
      projectId: options.projectId ?? "p1",
      relPath: options.relPath ?? "main.py",
      language: options.language ?? "python",
      mountTick: 0,
    });
    return null;
  }

  return { Probe, model };
}

beforeEach(() => {
  FakeSocket.instances = [];
  contentHandler = null;
  setModelMarkers.mockClear();
  disposeContent.mockClear();
  vi.stubGlobal("WebSocket", FakeSocket);
  useAuthStore.setState({ accessToken: "token-abc" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("which files get a language server", () => {
  it("connects for a language the platform has one for", () => {
    const { Probe } = harness({ language: "python" });

    render(<Probe />);

    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0]?.url).toContain("language=python");
    expect(FakeSocket.instances[0]?.url).toContain("projectId=p1");
  });

  it("connects for Go, the second language", () => {
    const { Probe } = harness({ language: "go", relPath: "main.go" });

    render(<Probe />);

    expect(FakeSocket.instances[0]?.url).toContain("language=go");
  });

  it("opens nothing for a language Monaco already analyses itself", () => {
    // TypeScript has a worker in the browser. A second opinion from a
    // container would be a socket, a process and a duplicate set of markers.
    const { Probe } = harness({ language: "typescript", relPath: "a.ts" });

    render(<Probe />);

    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("opens nothing without a session", () => {
    useAuthStore.setState({ accessToken: null });
    const { Probe } = harness({});

    render(<Probe />);

    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("opens nothing before the project is known", () => {
    // The playground mounts before the tree store has an id.
    const { Probe } = harness({ projectId: "" });

    render(<Probe />);

    expect(FakeSocket.instances).toHaveLength(0);
  });
});

describe("what it says to the server", () => {
  it("opens the document only after initialize is answered", () => {
    // The spec requires the handshake first, and a server that receives
    // didOpen before initialize is entitled to ignore it -- which reads as
    // "diagnostics never arrive".
    const { Probe } = harness({});
    render(<Probe />);

    const socket = FakeSocket.instances[0];
    act(() => {
      socket?.open();
    });

    expect(
      socket
        ?.messages()
        .some((message) => message.method === "textDocument/didOpen"),
    ).toBe(false);
  });

  it("names the file by its path inside the container", async () => {
    // The server sees container paths; the editor sees `inmemory:` URIs.
    // Sending a Monaco URI would have the server analysing a file it cannot
    // find, and answering about a URI the client would then not recognise.
    const { Probe } = harness({ relPath: "src/app.py" });
    render(<Probe />);

    const socket = FakeSocket.instances[0];
    act(() => {
      socket?.open();
      socket?.deliver({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
    });
    await act(async () => {
      await Promise.resolve();
    });

    const didOpen = socket
      ?.messages()
      .find((message) => message.method === "textDocument/didOpen");
    expect(didOpen?.params).toMatchObject({
      textDocument: { uri: "file:///home/sandbox/app/src/app.py" },
    });
  });
});

describe("what the editor does with the answers", () => {
  it("turns diagnostics into markers for the open file", () => {
    const { Probe } = harness({ relPath: "main.py" });
    render(<Probe />);

    const socket = FakeSocket.instances[0];
    act(() => {
      socket?.open();
      socket?.deliver({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri: "file:///home/sandbox/app/main.py",
          diagnostics: [
            {
              range: {
                start: { line: 3, character: 11 },
                end: { line: 3, character: 26 },
              },
              severity: 1,
              message: "undefined name",
            },
          ],
        },
      });
    });

    expect(setModelMarkers).toHaveBeenCalled();
    const markers = setModelMarkers.mock.lastCall?.[2] as {
      startLineNumber: number;
      startColumn: number;
      severity: number;
    }[];
    // 0-based on the wire, 1-based in Monaco; severity 1 (Error) is Monaco's 8.
    expect(markers[0]).toMatchObject({
      startLineNumber: 4,
      startColumn: 12,
      severity: 8,
    });
  });

  it("ignores diagnostics about a different file", () => {
    // One connection per open file, so anything else is a document this
    // connection never opened.
    const { Probe } = harness({ relPath: "main.py" });
    render(<Probe />);

    const socket = FakeSocket.instances[0];
    act(() => {
      socket?.open();
      socket?.deliver({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri: "file:///home/sandbox/app/other.py",
          diagnostics: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
              message: "not about this file",
            },
          ],
        },
      });
    });

    expect(setModelMarkers).not.toHaveBeenCalled();
  });

  it("clears the markers when the server goes away", () => {
    // Stale squiggles outlive the analysis that produced them and become
    // quietly wrong as the file is edited -- worse than none, because they
    // look current.
    const { Probe } = harness({});
    render(<Probe />);

    const socket = FakeSocket.instances[0];
    act(() => {
      socket?.open();
      socket?.emit("close", { reason: "gone" });
    });

    expect(setModelMarkers).toHaveBeenCalledWith(expect.anything(), "lsp", []);
  });

  it("clears the markers and closes the socket when the file is closed", () => {
    const { Probe } = harness({});
    const view = render(<Probe />);

    const socket = FakeSocket.instances[0];
    act(() => {
      socket?.open();
    });
    view.unmount();

    expect(socket?.closed).toBe(true);
    expect(disposeContent).toHaveBeenCalled();
    expect(setModelMarkers).toHaveBeenLastCalledWith(
      expect.anything(),
      "lsp",
      [],
    );
  });

  it("tells the server the file changed", () => {
    const { Probe } = harness({});
    render(<Probe />);

    const socket = FakeSocket.instances[0];
    act(() => {
      socket?.open();
      contentHandler?.();
    });

    const change = socket
      ?.messages()
      .find((message) => message.method === "textDocument/didChange");
    // A change with no range is a whole-document replacement, which is what
    // both servers here accept despite declaring incremental sync.
    expect(change?.params).toMatchObject({
      contentChanges: [{ text: SOURCE }],
    });
  });
});
