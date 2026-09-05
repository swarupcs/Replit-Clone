import type {
  KernelClientMessage,
  KernelServerMessage,
} from "@replit-clone/shared";

/** A client for the kernel gateway. plan.md §12.3.
 *
 *  Smaller than `lspClient.ts` and for the same reason that file gives about
 *  not taking on `monaco-languageclient`: there is no request/response here at
 *  all. Executes go out, messages come back, and the only correlation is the
 *  `cellId` the caller chose — which the driver echoes on everything it
 *  produces for that cell. A promise-based API would be inventing a shape the
 *  protocol does not have; a cell's outputs arrive over seconds and the point
 *  is to render them as they land.
 */

export type KernelState =
  /** No socket, and none asked for. A notebook opens in this state — a kernel
   *  starts a container, and opening a file must not. */
  | "idle"
  | "connecting"
  | "starting"
  | "ready"
  | "busy"
  /** The gateway refused, or the kernel died. `error` says why. */
  | "failed";

export interface KernelClientOptions {
  onMessage: (message: KernelServerMessage) => void;
  onState: (state: KernelState, error?: string) => void;
}

export class KernelClient {
  private socket: WebSocket | null = null;
  private disposed = false;
  private queue: string[] = [];

  constructor(
    private readonly url: string,
    private readonly options: KernelClientOptions,
  ) {}

  connect(): void {
    if (this.socket || this.disposed) return;

    this.options.onState("connecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      // Anything asked for while connecting goes out now, in order. Without
      // this, clicking Run on a cold notebook loses the cell that started the
      // kernel — the click that the user is watching.
      for (const payload of this.queue.splice(0)) socket.send(payload);
    });

    socket.addEventListener("message", (event) => {
      if (this.disposed) return;
      if (typeof event.data !== "string") return;

      let message: KernelServerMessage;
      try {
        message = JSON.parse(event.data) as KernelServerMessage;
      } catch {
        return;
      }

      if (message.type === "ready") this.options.onState("ready");
      if (message.type === "status") {
        this.options.onState(
          message.state === "busy"
            ? "busy"
            : message.state === "starting"
              ? "starting"
              : "ready",
        );
      }
      if (message.type === "fatal") {
        this.options.onState("failed", message.message);
      }

      this.options.onMessage(message);
    });

    socket.addEventListener("close", (event) => {
      if (this.disposed) return;
      this.socket = null;
      // The gateway refuses an upgrade by writing a 503 and destroying the
      // socket, so a refusal reaches the browser as a close with no message.
      // `reason` carries what there is; the panel says the rest.
      this.options.onState("failed", event.reason || undefined);
    });

    socket.addEventListener("error", () => {
      // Always followed by a close event, which is where the state changes.
      // Handled only so an unhandled error event does not reach the console.
    });
  }

  send(message: KernelClientMessage): void {
    if (this.disposed) return;
    const payload = JSON.stringify(message);

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(payload);
      return;
    }

    this.queue.push(payload);
    // Sending is what starts a kernel: nothing connects on open, because
    // opening a notebook must not start a container.
    this.connect();
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.socket?.close();
    this.socket = null;
  }
}

export function kernelSocketUrl(
  projectId: string,
  language: string,
  token: string,
): string {
  const backend = new URL(import.meta.env.VITE_BACKEND_URL);
  const protocol = backend.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ projectId, language, token });

  return `${protocol}//${backend.host}/kernel?${query.toString()}`;
}
