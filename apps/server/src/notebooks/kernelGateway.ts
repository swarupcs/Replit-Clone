import type { IncomingMessage, Server } from "node:http";
import { PassThrough, type Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { WebSocketServer, type WebSocket } from "ws";
import type { KernelServerMessage } from "@replit-clone/shared";
import { verifyAccessToken } from "../service/tokenService.js";
import { assertProjectAccess } from "../service/projectAccessService.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import {
  ensureContainer,
  attach,
  detach,
  MOUNT_POINT,
} from "../containers/containerManager.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import { getTemplate } from "../templates/registry.js";
import { KERNELS, canStartKernel, kernelForLanguage } from "./kernelPolicy.js";

/** A WebSocket bridge between the notebook editor and a Jupyter kernel running
 *  inside the project's container. plan.md §12.3.
 *
 *  The third of these — `terminalGateway`, `lspGateway`, this — and
 *  deliberately the same shape, because the interesting differences are all in
 *  the framing:
 *
 *  - the terminal has none; a PTY chunk is bytes.
 *  - LSP has `Content-Length` headers, so a chunk boundary is not a message.
 *  - a kernel here speaks newline-delimited JSON, one object per line, which
 *    the driver in the container flushes per line.
 *
 *  **Nothing here speaks Jupyter's actual protocol**, and that is the design.
 *  Five ZeroMQ sockets with HMAC signing stay inside the container, in
 *  `images/python/rc-kernel.py`, where the library that implements them
 *  already lives. What crosses this boundary is a vocabulary a renderer can
 *  use — see `KernelServerMessage`.
 */

/** Bytes a half-received line may occupy before the connection is closed.
 *
 *  Larger than the LSP gateway's, and for a reason a notebook makes obvious: a
 *  single `display_data` carrying a matplotlib figure is a base64 PNG on one
 *  line, and a large seaborn plot clears a megabyte without being unusual.
 *  32 MB is not a limit anybody should reach; it is a ceiling on how much a
 *  kernel that never sends a newline can make this process allocate. */
const MAX_PENDING_BYTES = 32 * 1024 * 1024;

function tokenFromRequest(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams.get("token");
}

/** Splits a stream into newline-delimited messages, holding the partial tail.
 *
 *  Its own class for the reason `MessageReader` is: the mistake it exists to
 *  prevent — treating a chunk boundary as a message boundary — produces
 *  corruption that is invisible until an output happens to straddle one, and
 *  outputs straddle chunk boundaries exactly when they are large, which is
 *  exactly when a person is least able to say what went wrong.
 */
export class LineReader {
  private buffer = "";
  /** Holds a multi-byte character that a chunk ended in the middle of.
   *
   *  `chunk.toString("utf8")` cannot: it decodes each chunk independently and
   *  turns a split character into replacement marks, which is data loss with
   *  no error attached. A test caught this, and the traffic here makes it a
   *  certainty rather than a risk -- a Python traceback is drawn out of
   *  box-drawing characters and ANSI escapes, and it arrives in 64 KB Docker
   *  frames that land wherever they land. */
  private readonly decoder = new StringDecoder("utf8");

  get pending(): number {
    return this.buffer.length;
  }

  push(chunk: Buffer): string[] {
    this.buffer += this.decoder.write(chunk);
    const parts = this.buffer.split("\n");
    // The last part is whatever came after the final newline: either "" or a
    // line still arriving. Either way it stays.
    this.buffer = parts.pop() ?? "";
    return parts.filter((line) => line.trim() !== "");
  }
}

/** How the kernel driver is exec'd inside the project's container.
 *
 *  Its own function for the same reason `languageServerExec` is, and pinned by
 *  a test to the same two facts that were wrong there once:
 *
 *  **WorkingDir is the mount point, not a literal.** A notebook's `open()` and
 *  `pd.read_csv("sales.csv")` are relative to it, so a kernel started anywhere
 *  else reads a different directory than the one the file it came from lives
 *  in — which fails as "no such file" for a file the user can see in the tree.
 *
 *  **Tty must stay false.** With a TTY, Docker merges stdout and stderr into
 *  one stream, and any warning the driver's own dependencies print on startup
 *  would be spliced into the JSON the renderer is parsing.
 */
export function kernelExec(argv: string[]): {
  Cmd: string[];
  AttachStdin: boolean;
  AttachStdout: boolean;
  AttachStderr: boolean;
  Tty: boolean;
  WorkingDir: string;
} {
  return {
    Cmd: argv,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    WorkingDir: MOUNT_POINT,
  };
}

export function installKernelGateway(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/kernel")) return;

    void (async () => {
      try {
        const token = tokenFromRequest(req);
        if (!token) throw new Error("Missing access token");

        const claims = verifyAccessToken(token);
        const projectId = assertValidProjectId(
          url.searchParams.get("projectId") ?? "",
        );

        // A kernel runs arbitrary code against the project's files with the
        // project's credentials. That is a shell, so it needs what a shell
        // needs — a viewer must not get one by opening a notebook.
        const project = await assertProjectAccess(
          projectId,
          claims.sub,
          "editor",
        );

        const language = kernelForLanguage(
          url.searchParams.get("language") ?? undefined,
        );

        const verdict = canStartKernel(
          language ?? (url.searchParams.get("language") ?? "unknown"),
          getTemplate(project.template).image,
        );

        if (!verdict.allowed) {
          // Refused before any container work, with the reason, exactly as
          // the LSP gateway does. A notebook whose kernel cannot start still
          // opens and still edits; what the user needs is the sentence saying
          // why Run is not available, not a spinner that never resolves.
          socket.write(
            `HTTP/1.1 503 Service Unavailable\r\n` +
              `Content-Type: text/plain\r\n\r\n${verdict.message}`,
          );
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          void startKernel(ws, projectId, language ?? "python");
        });
      } catch (error) {
        logger.warn("rejected a kernel upgrade", {
          reason: error instanceof Error ? error.message : "unknown",
        });
        socket.destroy();
      }
    })();
  });
}

function send(ws: WebSocket, message: KernelServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

async function startKernel(
  ws: WebSocket,
  projectId: string,
  language: string,
): Promise<void> {
  const kernel = KERNELS[language];
  if (!kernel) {
    ws.close(4400, "No kernel for that language");
    return;
  }

  // Same as the LSP gateway: a kernel holding the container open is a session
  // as far as the idle reaper is concerned, because a notebook left running a
  // fit for twenty minutes is not an idle project.
  attach(projectId);

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    detach(projectId);
  };
  ws.on("close", release);

  try {
    const container = await ensureContainer(projectId);

    // The client can go away while the container starts, and routinely does —
    // a notebook opened and closed again is one click. Starting a kernel for
    // a socket nobody holds leaves a Python process inside the container with
    // nothing attached and nothing that would ever close it.
    if (ws.readyState !== ws.OPEN) {
      release();
      return;
    }

    const exec = await container.exec(kernelExec(kernel.argv));
    const stream = await exec.start({ hijack: true, stdin: true });

    const reader = new LineReader();

    // Docker multiplexes stdout and stderr over one stream with an 8-byte
    // header per frame when Tty is false. Splitting them is what lets the
    // driver's own stderr be logged rather than parsed as a message.
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const modem = container.modem as {
      demuxStream: (
        source: NodeJS.ReadableStream,
        out: NodeJS.WritableStream,
        err: NodeJS.WritableStream,
      ) => void;
    };
    modem.demuxStream(stream, stdout, stderr);

    stdout.on("data", (chunk: Buffer) => {
      if (reader.pending > MAX_PENDING_BYTES) {
        ws.close(1009, "The kernel sent an oversized message");
        return;
      }
      // Forwarded verbatim. The driver already emits this vocabulary, so
      // re-parsing here would buy nothing but a second place for the shape to
      // drift.
      for (const line of reader.push(chunk)) {
        if (ws.readyState === ws.OPEN) ws.send(line);
      }
    });

    stderr.on("data", (chunk: Buffer) => {
      logger.debug("kernel stderr", {
        projectId,
        language,
        text: chunk.toString("utf8").slice(0, 500),
      });
    });

    ws.on("message", (data) => {
      const text =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : "";
      if (!text) return;

      // One line per message, and the newline is this side's job: the driver
      // reads line by line, so a message sent without one would be joined to
      // the next and neither would parse.
      stream.write(`${text.replace(/\n/g, " ")}\n`);
    });

    const stop = (): void => {
      stream.end();
      release();
    };
    ws.on("close", stop);

    stdout.on("end", () => {
      // The driver exited. Said as a message rather than only as a close code
      // because a kernel killed for memory is the single most likely way this
      // ends, and "the socket closed" is not something a person can act on.
      send(ws, { type: "fatal", message: "The kernel stopped." });
      if (ws.readyState === ws.OPEN) ws.close(1000, "The kernel exited");
    });

    increment("kernels_started");
    logger.info("kernel started", { projectId, language });
  } catch (error) {
    increment("kernels_failed");
    logger.error("could not start kernel", error, { projectId, language });
    send(ws, { type: "fatal", message: "Could not start the kernel." });
    release();
    ws.close(1011, "Could not start the kernel");
  }
}
