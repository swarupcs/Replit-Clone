import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { handleContainerCreate } from "./containers/handleContainerCreate.js";
import { handleTerminalCreation } from "./containers/handleTerminalCreation.js";
import { env } from "./config/env.js";
import { verifyAccessToken } from "./service/tokenService.js";
import { assertProjectAccess, touchProject } from "./service/projectService.js";

const app = express();
const server = createServer(app);

app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));

server.listen(env.TERMINAL_PORT, () => {
  console.log(`Terminal server is running on port ${env.TERMINAL_PORT}`);
});

const webSocketForTerminal = new WebSocketServer({ server });

/** Reads the access token from the WebSocket subprotocol.
 *
 *  The browser WebSocket API cannot set an Authorization header, and a token in
 *  the query string ends up in access logs, so the client sends
 *  `new WebSocket(url, ["auth", token])` and we read the second value.
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

webSocketForTerminal.on(
  "connection",
  async (ws: WebSocket, req: IncomingMessage) => {
    try {
      // `req.url` is path + query only, so it needs a base to parse against.
      const url = new URL(req.url ?? "/", "http://localhost");

      if (!url.pathname.startsWith("/terminal")) {
        ws.close(1008, "Unknown endpoint");
        return;
      }

      const token = tokenFromRequest(req);
      if (!token) {
        ws.close(1008, "Missing access token");
        return;
      }

      const claims = verifyAccessToken(token);

      const projectId = url.searchParams.get("projectId");
      if (!projectId) {
        ws.close(1008, "projectId is required");
        return;
      }

      // A terminal is a shell inside the project's container, so it needs the
      // same ownership check as any other project operation.
      await assertProjectAccess(projectId, claims.sub);
      await touchProject(projectId);

      const container = await handleContainerCreate(projectId);
      if (!container) {
        ws.close(1011, "Failed to start the project container");
        return;
      }

      handleTerminalCreation(container, ws);
    } catch (error) {
      console.error("Terminal connection rejected:", error);
      ws.close(1008, "Unauthorized");
    }
  },
);
