import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import chokidar from "chokidar";
import type { FSWatcher } from "chokidar";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from "@replit-clone/shared";
import apiRouter from "./routes/index.js";
import { PORT } from "./config/serverConfig.js";
import { projectDir } from "./service/projectService.js";
import {
  handleEditorSocketEvents,
  type EditorSocket,
} from "./socketHandlers/editorHandler.js";

const app = express();
const server = createServer(app);

const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

app.use("/api", apiRouter);

app.get("/ping", (_req, res) => {
  res.json({ message: "pong" });
});

const editorNamespace = io.of("/editor");

editorNamespace.on("connection", (socket: EditorSocket) => {
  const { projectId } = socket.handshake.query;

  let watcher: FSWatcher | undefined;

  if (typeof projectId === "string" && projectId.length > 0) {
    socket.data.projectId = projectId;

    watcher = chokidar.watch(projectDir(projectId), {
      ignored: (target: string) => target.includes("node_modules"),
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 2000 },
      ignoreInitial: true,
    });

    watcher.on("all", (event, changedPath) => {
      console.log(event, changedPath);
    });
  }

  handleEditorSocketEvents(socket, editorNamespace);

  // The watcher previously outlived the socket, leaking one per connection.
  socket.on("disconnect", () => {
    void watcher?.close();
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
