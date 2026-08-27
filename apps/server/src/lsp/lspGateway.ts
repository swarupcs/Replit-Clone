import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import { PassThrough, type Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { verifyAccessToken } from "../service/tokenService.js";
import { assertProjectAccess } from "../service/projectAccessService.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import { ensureContainer, attach, detach } from "../containers/containerManager.js";
import { logger } from "../lib/logger.js";
import { MessageReader, encodeMessage } from "./framing.js";
import { LANGUAGE_SERVERS, canStartLanguageServer } from "./lspPolicy.js";

/** Bytes a half-received message may occupy before the connection is closed.
 *
 *  A server that never completes a message would otherwise grow the reader's
 *  buffer without limit. Generous, because a large `textDocument/didOpen` on
 *  a big file is legitimate. */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

function tokenFromRequest(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams.get("token");
}

/** A WebSocket bridge between Monaco's language client and a language server
 *  running inside the project's container.
 *
 *  The same shape as `terminalGateway` — an authorised upgrade attached to a
 *  process inside the container with a bidirectional stream — with two
 *  differences §3.2 names. The framing is LSP's `Content-Length` headers
 *  rather than raw PTY bytes, so a chunk boundary is not a message boundary.
 *  And there is no TTY, which is what lets stdout and stderr be told apart:
 *  a server's diagnostics on stderr must not be spliced into the JSON-RPC
 *  stream on stdout.
 */
export function installLspGateway(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/lsp")) return;

    void (async () => {
      try {
        const token = tokenFromRequest(req);
        if (!token) throw new Error("Missing access token");

        const claims = verifyAccessToken(token);
        const projectId = assertValidProjectId(
          url.searchParams.get("projectId") ?? "",
        );
        const language = url.searchParams.get("language") ?? "";

        // A language server reads the whole project and can be asked to
        // rename across it, so it needs the same level a shell does rather
        // than a viewer's.
        await assertProjectAccess(projectId, claims.sub, "editor");

        const verdict = canStartLanguageServer(language);
        if (!verdict.allowed) {
          // Refused with the reason, before any container work. §3.3 is
          // explicit that this must say so rather than starting a server and
          // letting the dev server be killed for memory.
          socket.write(
            `HTTP/1.1 503 Service Unavailable\r\n` +
              `Content-Type: text/plain\r\n\r\n${verdict.message}`,
          );
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          void startLanguageServer(ws, projectId, language);
        });
      } catch (error) {
        logger.warn("rejected an lsp upgrade", {
          reason: error instanceof Error ? error.message : "unknown",
        });
        socket.destroy();
      }
    })();
  });
}

async function startLanguageServer(
  ws: WebSocket,
  projectId: string,
  language: string,
): Promise<void> {
  const server = LANGUAGE_SERVERS[language];
  if (!server) {
    ws.close(4400, "No language server for that language");
    return;
  }

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

    // The client can go away while the container starts, and routinely does.
    // Starting a server for a socket nobody holds leaves a process inside the
    // container with nothing attached and nothing that would ever close it.
    if (ws.readyState !== ws.OPEN) {
      release();
      return;
    }

    const exec = await container.exec({
      Cmd: server.argv,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      // No TTY, deliberately: with one, stdout and stderr are merged into a
      // single stream and the server's own logging would be spliced into the
      // JSON-RPC it is meant to be speaking.
      Tty: false,
      WorkingDir: "/app",
    });

    const stream = await exec.start({ hijack: true, stdin: true });

    const reader = new MessageReader();

    // Docker multiplexes stdout and stderr over one stream with an 8-byte
    // header per frame when Tty is false. `demuxStream` is dockerode's own
    // way of splitting them, and it is why stderr can be logged rather than
    // corrupting the protocol.
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
        ws.close(1009, "The language server sent an oversized message");
        return;
      }

      for (const message of reader.push(chunk)) {
        if (ws.readyState === ws.OPEN) ws.send(message);
      }
    });

    stderr.on("data", (chunk: Buffer) => {
      // The server's own diagnostics. Logged, never forwarded — the client
      // is speaking JSON-RPC and would choke on a log line.
      logger.debug("language server stderr", {
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
      if (text) stream.write(encodeMessage(text));
    });

    const stop = (): void => {
      stream.end();
      release();
    };

    ws.on("close", stop);
    stdout.on("end", () => {
      if (ws.readyState === ws.OPEN) ws.close(1000, "The language server exited");
    });

    logger.info("language server started", { projectId, language });
  } catch (error) {
    logger.error("could not start language server", error, { projectId, language });
    release();
    ws.close(1011, "Could not start the language server");
  }
}
