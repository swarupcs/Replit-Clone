/** A small LSP client for Monaco.
 *
 *  `monaco-languageclient` is the obvious thing to reach for, and this is
 *  deliberately not it — `docs/ROADMAP.md` §6, decision 2. That library pins
 *  peer versions of Monaco and of the vscode shim, and taking it on means
 *  letting it decide which Monaco this app runs, for a set of features that
 *  is, in the end, four provider registrations and a diagnostics push. When
 *  the language surface grows past what is here (rename, code actions,
 *  formatting, semantic tokens) the trade flips, and the seam to swap is
 *  this module.
 *
 *  Speaks JSON-RPC 2.0 over the WebSocket the gateway serves. The framing is
 *  the server's problem: it sends one whole message per WebSocket frame.
 */

export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number;
  message: string;
  source?: string;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export interface LspClientOptions {
  /** Called with the server's diagnostics for a file, as they arrive.
   *
   *  Pushed rather than polled: `textDocument/publishDiagnostics` is a
   *  notification, and the server decides when it has something to say. */
  onDiagnostics?: (uri: string, diagnostics: LspDiagnostic[]) => void;
  onClose?: (reason: string) => void;
}

export class LspClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private ready = false;
  private queue: string[] = [];

  constructor(
    private readonly url: string,
    private readonly options: LspClientOptions = {},
  ) {}

  connect(): void {
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.ready = true;
      // Anything requested while connecting goes out now, in order. Without
      // this the initialize handshake races the first didOpen.
      for (const payload of this.queue.splice(0)) socket.send(payload);
    });

    socket.addEventListener("message", (event) => {
      this.receive(typeof event.data === "string" ? event.data : "");
    });

    socket.addEventListener("close", (event) => {
      this.ready = false;
      // Every in-flight request must be settled, or a caller awaiting one
      // waits forever on a socket that is gone.
      for (const [, pending] of this.pending) {
        pending.reject(new Error("The language server disconnected"));
      }
      this.pending.clear();
      this.options.onClose?.(event.reason);
    });
  }

  private send(payload: object): void {
    const text = JSON.stringify(payload);
    if (this.ready && this.socket) this.socket.send(text);
    else this.queue.push(text);
  }

  private receive(text: string): void {
    if (!text) return;

    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };

    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      // A server that writes something that is not JSON is broken, but it is
      // not worth taking the editor down over.
      return;
    }

    if (typeof message.id === "number" && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);

      if (message.error) pending?.reject(new Error(message.error.message ?? "LSP error"));
      else pending?.resolve(message.result);
      return;
    }

    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as {
        uri?: string;
        diagnostics?: LspDiagnostic[];
      };
      if (params.uri) {
        this.options.onDiagnostics?.(params.uri, params.diagnostics ?? []);
      }
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** The handshake, plus the `initialized` notification the spec requires
   *  before anything else is sent. */
  async initialize(rootUri: string): Promise<void> {
    await this.request("initialize", {
      processId: null,
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false },
          completion: { completionItem: { snippetSupport: false } },
          hover: { contentFormat: ["plaintext", "markdown"] },
          publishDiagnostics: {},
        },
      },
    });
    this.notify("initialized", {});
  }

  dispose(): void {
    this.socket?.close();
    this.socket = null;
  }
}

/** LSP severities are 1-4 (Error, Warning, Information, Hint); Monaco's
 *  MarkerSeverity is 8, 4, 2, 1 for the same four, in the opposite order.
 *  Getting this backwards renders every error as a hint. */
export function toMarkerSeverity(severity: number | undefined): number {
  switch (severity) {
    case 1:
      return 8;
    case 2:
      return 4;
    case 3:
      return 2;
    default:
      return 1;
  }
}

/** LSP positions are 0-based; Monaco's are 1-based. */
export function toMonacoRange(range: LspDiagnostic["range"]): {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
} {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}
