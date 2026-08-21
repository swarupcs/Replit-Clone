import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import {
  attach,
  detach,
  ensureContainer,
} from "../containers/containerManager.js";
import { handleTerminalCreation } from "../containers/handleTerminalCreation.js";
import type { AttachInput } from "../containers/handleTerminalCreation.js";
import { assertProjectAccess, touchProject } from "../service/projectService.js";
import { verifyAccessToken } from "../service/tokenService.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import { logger } from "../lib/logger.js";
import { watchAccess } from "../service/accessWatch.js";
import { increment } from "../lib/metrics.js";
import { AppError } from "../utils/errors.js";

/** Decodes a client frame to text.
 *
 *  `ws` hands over a Buffer, an ArrayBuffer, or — for a fragmented message —
 *  an array of Buffers. Calling `.toString()` on the last of those returns the
 *  fragments joined by commas rather than the text, so a long paste or a large
 *  terminal frame arrived corrupted.
 */
function decodeMessage(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

/** Reads the access token from the WebSocket subprotocol.
 *
 *  The browser WebSocket API cannot set an Authorization header, and a token in
 *  the query string ends up in access logs, so the client sends
 *  `new WebSocket(url, ["auth", token])` and we read the value after "auth".
 */
function tokenFromRequest(req: IncomingMessage): string | undefined {
  const raw = req.headers["sec-websocket-protocol"];
  if (!raw) return undefined;

  const parts = (Array.isArray(raw) ? raw.join(",") : raw)
    .split(",")
    .map((part) => part.trim());

  const authIndex = parts.indexOf("auth");
  return authIndex >= 0 ? parts[authIndex + 1] : undefined;
}

/** Mounts the terminal WebSocket on the MAIN http server.
 *
 *  This used to be an entirely separate Express app on its own port, with its
 *  own copy of the middleware and no npm script to start it. One process, one
 *  port, one place where auth is enforced.
 */
/** Distinguishes one terminal from another in the access watch. A WebSocket
 *  has no id of its own, and two shells on one project must be watched — and
 *  released — separately. */
let terminalCounter = 0;

function nextTerminalId(): number {
  terminalCounter += 1;
  return terminalCounter;
}

export function installTerminalGateway(server: Server): void {
  // `noServer` so we own the upgrade and can reject before allocating a socket.
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // socket.io and the preview proxy handle their own upgrades.
    if (!url.pathname.startsWith("/terminal")) return;

    void (async () => {
      try {
        const token = tokenFromRequest(req);
        if (!token) throw new Error("Missing access token");

        const claims = verifyAccessToken(token);

        const projectId = assertValidProjectId(
          url.searchParams.get("projectId") ?? "",
        );

        // A terminal is a shell inside the project's container, so it needs the
        // same ownership check as any other project operation.
        // A shell can write anything the project can, so read-only access is
        // not enough for one.
        const project = await assertProjectAccess(projectId, claims.sub, "editor");

        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          // Buffer client input from the instant the socket exists. Starting
          // the container and the exec is asynchronous, but the terminal sends
          // its initial resize the moment it connects — without this the PTY
          // stayed at 0x0 and every early keystroke was dropped.
          const inbox: string[] = [];
          let sink: ((data: string) => void) | null = null;

          ws.on("message", (data) => {
            const text = decodeMessage(data);
            if (sink) sink(text);
            else inbox.push(text);
          });

          const attachInput = (handler: (data: string) => void): void => {
            sink = handler;
            for (const buffered of inbox.splice(0)) handler(buffered);
          };

          // A shell is the most privileged thing on offer here, and its
          // authorisation was checked once at the upgrade and never again.
          // Someone removed from a project kept a working shell inside its
          // container until they closed the tab.
          const releaseAccessWatch = watchAccess(`terminal:${String(nextTerminalId())}`, {
            userId: claims.sub,
            projectId,
            level: "editor",
            onRevoked: () => {
              ws.close(4403, "Your access to this project was removed");
            },
            // A demotion to viewer is the same thing for a terminal: read-only
            // access does not include a shell that can write the whole tree.
            onChanged: (level) => {
              if (level === "viewer") {
                ws.close(4403, "You no longer have write access to this project");
              }
            },
          });

          ws.on("close", releaseAccessWatch);

          void startTerminal(ws, projectId, project.template, attachInput);
        });
      } catch (error) {
        logger.warn("terminal upgrade rejected", {
          reason: error instanceof Error ? error.message : String(error),
        });
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
      }
    })();
  });
}

async function startTerminal(
  ws: WebSocket,
  projectId: string,
  templateId: string,
  attachInput: AttachInput,
): Promise<void> {
  attach(projectId);
  increment("terminal_sessions");
  ws.on("close", () => detach(projectId));

  try {
    await touchProject(projectId);

    const container = await ensureContainer(projectId);
    handleTerminalCreation(container, ws, templateId, attachInput);
  } catch (error) {
    logger.error("could not start terminal", error, { projectId });
    detach(projectId);
    // Relay the real reason when it is safe to show (an AppError, e.g. the
    // at-capacity 503), so the terminal can tell the user to close a project
    // instead of showing a bare "Disconnected". WebSocket close reasons are
    // capped at 123 UTF-8 bytes, so keep it short.
    const reason =
      error instanceof AppError
        ? error.message
        : "Could not start the project container";
    ws.close(1011, reason.slice(0, 120));
  }
}
