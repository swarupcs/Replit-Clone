import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { createServer } from "node:http";
import { Server } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from "@replit-clone/shared";
import apiRouter from "./routes/index.js";
import {
  createPreviewProxy,
  installPreviewUpgrade,
  previewGuard,
} from "./routes/preview.js";
import { env, isProduction } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { logger } from "./lib/logger.js";
import { touchProject } from "./service/projectService.js";
import { retainProjectWatcher } from "./service/projectWatcher.js";
import { reportExternalChanges } from "./service/collabWatch.js";
import { installSocketAuth } from "./middlewares/socketAuth.js";
import { pruneExpiredRefreshTokens } from "./service/refreshTokenService.js";
import { pruneUserTokens } from "./service/userTokenService.js";
import { errorHandler, notFoundHandler } from "./middlewares/errorHandler.js";
import { requestLogger } from "./middlewares/requestLogger.js";
import { healthCheck } from "./controllers/healthController.js";
import { asyncHandler } from "./middlewares/errorHandler.js";
import { installTerminalGateway } from "./terminal/terminalGateway.js";
import {
  attach,
  detach,
  ensureNetwork,
  reconcileOnBoot,
  startIdleReaper,
  stopAllContainers,
} from "./containers/containerManager.js";
import {
  handleEditorSocketEvents,
  type EditorSocket,
} from "./socketHandlers/editorHandler.js";

const app = express();
const server = createServer(app);

// How far to look into X-Forwarded-For for the real client address. Without it
// every request behind a reverse proxy reports the proxy's own IP, and the
// per-IP rate limits below end up shared by the entire deployment.
app.set("trust proxy", env.TRUSTED_PROXY_HOPS);

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
  // engine.io destroys any upgrade request it does not recognise. The terminal
  // WebSocket shares this HTTP server, so that default would kill every
  // /terminal upgrade before our own handler could take it.
  destroyUpgrade: false,
});

app.use(
  helmet({
    // The preview proxy serves arbitrary user apps; helmet's default CSP and
    // COEP headers would break them, and they are not ours to police.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    // Previews are framed by the editor, which is a different port.
    crossOriginResourcePolicy: false,
  }),
);
app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
app.use(cookieParser());

// Before the routes, so everything below inherits a request id.
app.use(requestLogger);

// Liveness only, and deliberately trivial: kept because things may already
// point at it. /health is the one that checks Postgres and Docker.
app.get("/ping", (_req, res) => {
  res.json({ message: "pong" });
});

app.get("/health", asyncHandler(healthCheck));

// Mounted BEFORE the body parsers: the proxy has to stream the original request
// body through, and express.json would have already consumed it.
const previewProxy = createPreviewProxy();
app.use("/preview/:projectId", previewGuard, previewProxy);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

  // Told up front, so the client can present read-only access as read-only
  // instead of letting each action fail separately.
  socket.emit("projectAccess", { level: socket.data.accessLevel });
  void touchProject(projectId);
  attach(projectId);

  // One watcher per project, shared by every tab. It used to be created per
  // connection, so two tabs meant two recursive watchers over the same tree and
  // two refetch broadcasts per change.
  const releaseWatcher = retainProjectWatcher(projectId, () => {
    editorNamespace.to(projectId).emit("treeChanged");

    // A terminal command or a build step may have rewritten a file somebody is
    // editing. There is nothing to merge against — an external writer produces
    // whole new contents with no record of the edits that made them — so this
    // reports the conflict and leaves the document alone.
    void reportExternalChanges(projectId, editorNamespace);
  });

  handleEditorSocketEvents(socket, editorNamespace);

  socket.on("disconnect", () => {
    detach(projectId);
    releaseWatcher();
  });
});

// The terminal was a second Express app on its own port with no npm script.
installTerminalGateway(server);

// Vite's HMR socket rides the preview path, and Express middleware does not run
// for upgrades — so this authorises and routes them itself.
installPreviewUpgrade(server, previewProxy);

/** Clears refresh tokens that can no longer authorise anything.
 *
 *  Rotation writes a row per refresh, so without this the table grows for the
 *  lifetime of the deployment. Hourly is far more often than needed for a
 *  30-day expiry; it just keeps the first sweep after a restart soon.
 */
function startTokenPrune(): void {
  const sweep = (): void => {
    void pruneExpiredRefreshTokens().catch((error: unknown) => {
      logger.error("could not prune refresh tokens", error);
    });
    void pruneUserTokens().catch((error: unknown) => {
      logger.error("could not prune user tokens", error);
    });
  };

  sweep();
  setInterval(sweep, 60 * 60 * 1000).unref();
}

async function start(): Promise<void> {
  await ensureNetwork();

  // A crash or a `docker kill` leaves containers whose project is gone, and
  // directories with no row. Neither used to be cleaned up, ever.
  const reconciled = await reconcileOnBoot().catch((error: unknown) => {
    logger.error("boot reconcile failed", error);
    return undefined;
  });
  if (reconciled) logger.info("reconciled state", { ...reconciled });

  startIdleReaper();
  startTokenPrune();

  // A `tsx watch` restart can race the previous process releasing the port on
  // Windows, which otherwise kills the dev server outright.
  let attemptsLeft = 10;

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE" || attemptsLeft-- <= 0) {
      logger.error("server listen failed", error);
      process.exit(1);
    }
    setTimeout(() => server.listen(env.PORT), 300);
  });

  server.listen(env.PORT, () => {
    logger.info("server listening", { port: env.PORT });
  });
}

/** Reports a fatal startup failure and exits.
 *
 *  `start` awaits the Docker daemon before it ever calls `listen`, so a daemon
 *  that is not up yet — an ordinary race on a rebooting VM — takes the whole
 *  process down. Node already does that on its own for an unhandled rejection;
 *  this only replaces a bare stack trace with a line saying which stage failed,
 *  which is the difference between a legible restart loop and a puzzling one.
 *
 *  Deliberately no `unhandledRejection` listener: registering one would stop
 *  Node exiting by default, which is the behaviour we want here.
 */
function die(reason: string, error: unknown): never {
  logger.error(reason, error);
  process.exit(1);
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info("shutting down", { signal });

  // Awaited so in-flight requests and sockets are given a chance to finish;
  // these used to be fired and forgotten a line before process.exit.
  await io.close();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  // Only on a real shutdown: otherwise a restart leaves orphaned containers
  // holding the VM's memory. In development, tearing down every container on
  // each file save would make iteration painfully slow.
  if (isProduction) {
    await stopAllContainers();
  }

  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

start().catch((error: unknown) => {
  die("Could not start the server", error);
});
