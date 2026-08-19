import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { handleContainerCreate } from "./containers/handleContainerCreate.js";
import { handleTerminalCreation } from "./containers/handleTerminalCreation.js";
import { TERMINAL_PORT } from "./config/serverConfig.js";

const app = express();
const server = createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

server.listen(TERMINAL_PORT, () => {
  console.log(`Terminal server is running on port ${TERMINAL_PORT}`);
});

const webSocketForTerminal = new WebSocketServer({ server });

webSocketForTerminal.on(
  "connection",
  async (ws: WebSocket, req: IncomingMessage) => {
    // `req.url` is path + query only, so it needs a base to parse against.
    const url = new URL(req.url ?? "/", "http://localhost");

    if (!url.pathname.startsWith("/terminal")) return;

    const projectId = url.searchParams.get("projectId");
    if (!projectId) {
      ws.close(1008, "projectId is required");
      return;
    }

    const container = await handleContainerCreate(projectId);
    if (!container) {
      ws.close(1011, "Failed to start the project container");
      return;
    }

    handleTerminalCreation(container, ws);
  },
);
