import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
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
import { env } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { projectDir, touchProject } from "./service/projectService.js";
import { installSocketAuth } from "./middlewares/socketAuth.js";
import { errorHandler, notFoundHandler } from "./middlewares/errorHandler.js";
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
    // Locked to the web origin. It was '*', which combined with no auth meant
    // any page on the internet could drive this server.
    origin: env.WEB_ORIGIN,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.use(helmet());
app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.get("/ping", (_req, res) => {
  res.json({ message: "pong" });
});

app.use("/api", apiRouter);

app.use(notFoundHandler);
app.use(errorHandler);

const editorNamespace = io.of("/editor");
installSocketAuth(editorNamespace);

editorNamespace.on("connection", (socket: EditorSocket) => {
  const { projectId } = socket.data;

  // Scope broadcasts to this project. Success events previously went to the
  // whole namespace, leaking other users' file paths.
  void socket.join(projectId);
  void touchProject(projectId);

  const watcher: FSWatcher = chokidar.watch(projectDir(projectId), {
    ignored: (target: string) => target.includes("node_modules"),
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 2000 },
    ignoreInitial: true,
  });

  // The watcher used to only console.log, so the client's tree never refreshed.
  watcher.on("all", () => {
    editorNamespace.to(projectId).emit("treeChanged");
  });

  handleEditorSocketEvents(socket, editorNamespace);

  // The watcher previously outlived the socket, leaking one per connection.
  socket.on("disconnect", () => {
    void watcher.close();
  });
});

server.listen(env.PORT, () => {
  console.log(`Server is running on port ${env.PORT}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, shutting down`);
  io.close();
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
