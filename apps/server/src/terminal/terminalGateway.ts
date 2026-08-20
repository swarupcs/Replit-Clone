import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
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
        const project = await assertProjectAccess(projectId, claims.sub);

        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          // Buffer client input from the instant the socket exists. Starting
          // the container and the exec is asynchronous, but the terminal sends
          // its initial resize the moment it connects — without this the PTY
          // stayed at 0x0 and every early keystroke was dropped.
          const inbox: string[] = [];
          let sink: ((data: string) => void) | null = null;

          ws.on("message", (data) => {
            const text = data.toString();
            if (sink) sink(text);
            else inbox.push(text);
          });

          const attachInput = (handler: (data: string) => void): void => {
            sink = handler;
            for (const buffered of inbox.splice(0)) handler(buffered);
          };

          void startTerminal(ws, projectId, project.template, attachInput);
        });
      } catch (error) {
        console.error("Terminal upgrade rejected:", error);
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
  ws.on("close", () => detach(projectId));

  try {
    await touchProject(projectId);

    const container = await ensureContainer(projectId);
    handleTerminalCreation(container, ws, templateId, attachInput);
  } catch (error) {
    console.error(`Could not start terminal for ${projectId}:`, error);
    detach(projectId);
    ws.close(1011, "Could not start the project container");
  }
}
