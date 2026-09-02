import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { createServer } from "node:http";
import {
  createPreviewServer,
  listenForPreviews,
} from "./previewServer.js";
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
import {
  createDeploySiteServer,
  installServiceUpgrade,
  listenForSites,
} from "./deploySite.js";
import { deployPort, env, isProduction, previewPort } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { logger } from "./lib/logger.js";
import { touchProject } from "./service/projectService.js";
import { retainProjectWatcher } from "./service/projectWatcher.js";
import {
  createPreviewAnnouncer,
  createPreviewHealthAnnouncer,
} from "./service/previewRefresh.js";
import { reportExternalChanges } from "./service/collabWatch.js";
import { touchFilesInContainer } from "./service/containerTouch.js";
import {
  forgetTouchEchoes,
  withoutOurOwnTouches,
} from "./service/touchEcho.js";
import { flushAllDocs, setDocSaveListener } from "./service/collabService.js";
import { startAccessWatch, watchAccess } from "./service/accessWatch.js";
import { installSocketAuth } from "./middlewares/socketAuth.js";
import { installSocketLogger } from "./middlewares/socketLogger.js";
import { pruneExpiredRefreshTokens } from "./service/refreshTokenService.js";
import { pruneUserTokens } from "./service/userTokenService.js";
import { errorHandler, notFoundHandler } from "./middlewares/errorHandler.js";
import { requestLogger } from "./middlewares/requestLogger.js";
import { healthCheck } from "./controllers/healthController.js";
import { asyncHandler } from "./middlewares/errorHandler.js";
import { installTerminalGateway } from "./terminal/terminalGateway.js";
import { installLspGateway } from "./lsp/lspGateway.js";
import {
  attach,
  detach,
  ensureNetwork,
  reconcileOnBoot,
  startIdleReaper,
  stopAllContainers,
  setOnProjectReaped,
} from "./containers/containerManager.js";
import { ensureEgressGateway } from "./containers/egressGateway.js";
import { reconcileDeployments, restoreServices } from "./service/deployService.js";
import { recheckDomains } from "./service/customDomainService.js";
import { backfillSealedEnvVars } from "./service/projectEnvService.js";
import { reconcileJobRuns, runDueJobs } from "./service/scheduleService.js";
import { purgeExpiredTrash } from "./service/projectService.js";
import { startComputeMeter } from "./service/computeMeterService.js";
import { expireGracePeriods } from "./service/billingService.js";
import { apiSecurityHeaders } from "./middlewares/apiSecurityHeaders.js";
import { SandboxNetworkMismatch } from "./containers/sandboxNetwork.js";
import { stop as stopManagedDatabase } from "./service/managedDatabaseService.js";
import {
  docRoomName,
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

// Everything helmet had to leave off, because with PREVIEW_PORT=0 this app
// also proxies previews. See the module: the exemption is now the preview
// path rather than the whole server.
app.use(apiSecurityHeaders(previewPort === 0));

// Before the routes, so everything below inherits a request id.
app.use(requestLogger);

// Liveness only, and deliberately trivial: kept because things may already
// point at it. /health is the one that checks Postgres and Docker.
app.get("/ping", (_req, res) => {
  res.json({ message: "pong" });
});

app.get("/health", asyncHandler(healthCheck));

const editorNamespace = io.of("/editor");
installSocketAuth(editorNamespace);
// After auth: it logs connections that were admitted, and reads the user and
// project auth recorded on the socket.
installSocketLogger(editorNamespace);

// One per process, not per connection: the announcements are per project and
// debounced, so two tabs must not schedule two reloads for one save.
const announcePreviewChange = createPreviewAnnouncer(editorNamespace);

// Sees every preview response as it is proxied, so the room can be told when
// the dev server starts or stops answering with errors.
const announcePreviewHealth = createPreviewHealthAnnouncer(editorNamespace);

// Mounted BEFORE the body parsers: the proxy has to stream the original request
// body through, and express.json would have already consumed it.
const previewProxy = createPreviewProxy(announcePreviewHealth);

// Mounted on the API's own origin ONLY when previews have not been given one
// of their own. Sharing this origin means a project's code runs same-origin
// with the API, which the editor answers by withholding `allow-same-origin`
// from the iframe — and that costs every client-rendered preview its module
// scripts. See previewServer.ts.
if (previewPort === 0) {
  app.use("/preview/:projectId", previewGuard, previewProxy);
}

// Built either way, so shutdown has one thing to close; only bound when
// previews have an origin of their own.
const previewServer = createPreviewServer(previewProxy);

// The public origin. Built unconditionally for the same reason, and bound only
// when deployments are configured -- with DEPLOY_PORT=0 the feature is off and
// nothing listens, which is what the endpoints then report.
const deploySiteServer = createDeploySiteServer();
// A published app may serve a WebSocket, and Express middleware never sees an
// upgrade. Installed here rather than inside the factory so the listener and
// its handler are visible in one place.
installServiceUpgrade(deploySiteServer);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", apiRouter);

app.use(notFoundHandler);
app.use(errorHandler);

// While a file is shared the server writes it, so the client never sends
// `writeFile` and never sees `writeFileSuccess` — which is the only thing that
// clears a tab's unsaved marker. Without this every open file stayed dirty
// forever, long after it had reached disk.
setDocSaveListener((projectId, relPath) => {
  editorNamespace.to(docRoomName(projectId, relPath)).emit("docSaved", { relPath });
});

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
  const releaseWatcher = retainProjectWatcher(projectId, (reported) => {
    // Our own `touch` below lands on the host file too, so it comes back
    // through this same watcher as a change to the files we just touched.
    // Acting on that is a loop with no exit, and it ran: the tree refetched
    // forever, and the preview reloaded so often the dev server never finished
    // recompiling. Echoes are recognised and spent here rather than answered.
    const changedFiles = withoutOurOwnTouches(projectId, reported);
    if (changedFiles.length === 0) return;

    editorNamespace.to(projectId).emit("treeChanged");

    // The preview reloads too — on a bind mount that swallows inotify, this
    // is the only thing that ever tells it a save happened.
    announcePreviewChange.announce(projectId);

    // And the container's own watchers must be told as well, or a tool the
    // user started in the terminal sits dead while the file beside it changes.
    void touchFilesInContainer(projectId, changedFiles);

    // A terminal command or a build step may have rewritten a file somebody is
    // editing. There is nothing to merge against — an external writer produces
    // whole new contents with no record of the edits that made them — so this
    // reports the conflict and leaves the document alone.
    void reportExternalChanges(projectId, editorNamespace);
  });

  handleEditorSocketEvents(socket, editorNamespace);

  // Access was checked once, at the handshake, and never again — so removing
  // a collaborator left their open editor exactly as privileged as before,
  // for as long as they kept the page open.
  const releaseAccessWatch = watchAccess(socket.id, {
    userId: socket.data.userId,
    projectId,
    level: socket.data.accessLevel,
    onRevoked: () => {
      socket.emit("error", {
        code: "ACCESS_REVOKED",
        message: "Your access to this project was removed",
      });
      socket.disconnect(true);
    },
    onChanged: (level) => {
      // Written back because the per-event edit check reads it from here.
      socket.data.accessLevel = level;
      socket.emit("projectAccess", { level });
    },
  });

  socket.on("disconnect", () => {
    detach(projectId);
    // Only once nobody is watching any more: the echoes belong to the watch,
    // not to this socket, and another tab may still be reading them.
    if (releaseWatcher()) forgetTouchEchoes(projectId);
    releaseAccessWatch();
  });
});

// The terminal was a second Express app on its own port with no npm script.
installTerminalGateway(server);
// Same shape as the terminal gateway, different framing. Refuses before
// any container work when the memory policy says no.
installLspGateway(server);

// Vite's HMR socket rides the preview path, and Express middleware does not run
// for upgrades — so this authorises and routes them itself. Only when previews
// share this origin; the dedicated listener installs its own.
if (previewPort === 0) installPreviewUpgrade(server, previewProxy);

// Last, after every handler that owns a path has had its turn.
//
// Node destroys an upgrade nobody is listening for, but only while there are
// NO listeners at all. Three are registered above, and each returns silently
// for a path it does not own — so an upgrade to anything else was accepted and
// then abandoned, held open until the OS timed it out. Someone has to close
// them, and it may as well be the one that knows nobody else did.
server.on("upgrade", (req, socket) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (
    path.startsWith("/preview/") ||
    path.startsWith("/terminal") ||
    path.startsWith("/socket.io")
  ) {
    return;
  }

  // `destroyed` guards the case where a handler above already dealt with it
  // and simply did not match our prefixes.
  if (socket.destroyed) return;

  socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  socket.destroy();
});

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

/** Re-checks the DNS record behind every verified custom domain.
 *
 *  A verification that happened once and is believed forever means somebody
 *  who sold their domain keeps an address they no longer control, and the
 *  buyer's visitors land on the seller's code. `recheckDomains` only looks at
 *  rows whose last check has aged out, so this interval is how *often it can*
 *  notice rather than how often it queries anything.
 *
 *  Hourly against a daily staleness window, for the same reason the token
 *  prune is: it keeps the first sweep after a restart soon.
 */
/** Deletes for real what has been in the trash longer than the grace period.
 *
 *  Hourly, on the same machinery as the token prune above it, and it runs once
 *  at boot: a server that was down for a fortnight owes a purge, and waiting an
 *  hour to start would keep every one of those trees on disk for no reason.
 *
 *  Failures are logged and never propagate. A tree that will not delete must
 *  not stop the sweep -- one stuck project holding every other account's disk
 *  is a far worse outcome than one project that needs looking at by hand.
 */
function startTrashSweep(): void {
  const sweep = (): void => {
    void purgeExpiredTrash().catch((error: unknown) => {
      logger.error("could not purge trashed projects", error);
    });
  };

  sweep();
  setInterval(sweep, 60 * 60 * 1000).unref();
}

/** Drops accounts whose payment grace has run out to the free plan.
 *
 *  Necessary because nothing else would: the processor sends an event when a
 *  payment fails and another when it finally gives up, and between them is a
 *  week in which no event arrives at all. A deployment relying on webhooks
 *  alone would leave a lapsed account on its paid plan for as long as the
 *  processor kept retrying the card.
 */
function startGraceSweep(): void {
  const sweep = (): void => {
    void expireGracePeriods().catch((error: unknown) => {
      logger.error("could not expire grace periods", error);
    });
  };

  sweep();
  setInterval(sweep, 60 * 60 * 1000).unref();
}

function startDomainRecheck(): void {
  const sweep = (): void => {
    void recheckDomains()
      .then(({ checked, cleared }) => {
        if (checked > 0) logger.info("custom domains re-checked", { checked, cleared });
      })
      .catch((error: unknown) => {
        logger.error("could not re-check custom domains", error);
      });
  };

  sweep();
  setInterval(sweep, 60 * 60 * 1000).unref();
}

/** Starts the scheduled jobs that have come due.
 *
 *  Every minute, because cron's resolution is a minute and a sweeper that runs
 *  less often than the smallest unit it schedules is a scheduler that is
 *  quietly wrong — a job set for 03:00 firing at 03:04 is not what was asked
 *  for, and nothing in the interface would say so.
 *
 *  The sweep itself is one indexed query on `(enabled, nextRunAt)` and returns
 *  nothing almost every time it runs. That is the point of storing the next
 *  firing rather than deriving it: a minute's tick costs a query, not a parse
 *  of every expression on the machine.
 *
 *  NOT `unref`'d, unlike the hourly sweeps. A process whose only remaining
 *  work is a scheduled job should stay alive to do it; the hourly ones are
 *  housekeeping that can wait for the next boot.
 */
function startJobSweeper(): void {
  const sweep = (): void => {
    void runDueJobs()
      .then(({ started }) => {
        if (started > 0) logger.info("scheduled jobs started", { started });
      })
      .catch((error: unknown) => {
        logger.error("could not sweep scheduled jobs", error);
      });
  };

  sweep();
  setInterval(sweep, 60 * 1000);
}

/** How long a Docker call at boot may take before we give up on it.
 *
 *  The daemon can accept a connection and then never answer -- it is
 *  restarting, or busy recreating a container. Those calls have no timeout of
 *  their own, so without this the await never settles. */
const DOCKER_BOOT_TIMEOUT_MS = 15_000;

function withTimeout<T>(
  work: Promise<T>,
  label: string,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      logger.error(`${label} timed out`, undefined, {
        afterMs: DOCKER_BOOT_TIMEOUT_MS,
        hint: "is the Docker daemon running?",
      });
      resolve(undefined);
    }, DOCKER_BOOT_TIMEOUT_MS);

    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        // A call we already gave up on will usually reject later anyway.
        // Logging that too would report one failure twice, the second time
        // for a stage boot has long since moved past.
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logger.error(`${label} failed`, error);
        resolve(undefined);
      },
    );
  });
}

async function start(): Promise<void> {
  // Docker is deliberately NOT allowed to gate the listener. Signing in,
  // refreshing a session and listing projects need no daemon at all, so a
  // Docker outage should cost the container features and nothing else.
  //
  // It used to be awaited unbounded, which meant a daemon that was merely slow
  // -- restarting, or mid `compose up` -- left the process alive, silent, and
  // listening on nothing. From a browser that is indistinguishable from a
  // server that is not running, and `tsx watch` never retries because nothing
  // ever crashed.
  await withTimeout(
    ensureNetwork().catch((error: unknown) => {
      // withTimeout swallows failures on purpose: a Docker daemon that is
      // down or slow should cost the container features and nothing else.
      // This one refusal is not that. It means the sandbox network is not
      // the one the configuration describes: either filtering is on and not
      // in effect, so every sandbox has unrestricted outbound access while
      // the configuration says otherwise, or the network cannot publish the
      // ports previews are resolved through, so every preview reports that
      // nothing is running. Either way the server would carry on serving with
      // the reason sitting in a log line nobody reads until afterwards, and
      // the guard is only a guard if it stops the boot.
      if (error instanceof SandboxNetworkMismatch) {
        logger.error("refusing to start", error);
        process.exit(1);
      }
      throw error;
    }),
    "docker network setup",
  );

  // The sandbox network's only way out, when it is cut off from having one
  // of its own. Before the reconcile below rather than after, and before any
  // project can be opened: a container whose install fails because the
  // gateway was not up yet looks exactly like a project that is broken.
  await withTimeout(ensureEgressGateway(), "egress gateway");

  // A crash or a `docker kill` leaves containers whose project is gone, and
  // directories with no row. Neither used to be cleaned up, ever.
  const reconciled = await withTimeout(reconcileOnBoot(), "boot reconcile");
  if (reconciled) logger.info("reconciled state", { ...reconciled });

  // ...and the same question asked of the database, which the sweep above has
  // never asked: it reconciles CONTAINERS and directories, and a row that says
  // a job is running or a build is in progress outlives the process that was
  // doing it. The job half is the one that matters -- an unfinished RUNNING row
  // makes every later firing write SKIPPED, and SKIPPED deliberately tells
  // nobody anything, so an ordinary deploy could end a nightly backup in
  // silence. Before the sweeper starts, so the first firing after boot sees a
  // settled table.
  const abandonedRuns = await withTimeout(reconcileJobRuns(), "job run reconcile");
  const abandonedBuilds = await withTimeout(reconcileDeployments(), "deployment reconcile");
  if (abandonedRuns || abandonedBuilds) {
    logger.info("reconciled rows", { abandonedRuns, abandonedBuilds });
  }

  // Published services, which the reconcile above deliberately does not touch:
  // it sweeps `rc-project-` containers, and a deployment is not one. Always-on
  // has to survive this process restarting, or it only means "until the next
  // deploy of the platform".
  const services = await withTimeout(restoreServices(), "service deployments");
  if (services?.restored) logger.info("service deployments restored", { ...services });

  // A project's database is stopped with the project, so an idle pair costs
  // nothing rather than half of nothing.
  setOnProjectReaped(async (projectId) => {
    await stopManagedDatabase(projectId).catch(() => undefined);
  });
  startIdleReaper();
  // Alongside the reaper and not inside it: the reaper decides how long an
  // abandoned container keeps costing, and a meter that shared its try/catch
  // would take the more important of the two down with it.
  startComputeMeter();
  startTokenPrune();
  startTrashSweep();
  startGraceSweep();
  startDomainRecheck();
  startJobSweeper();
  startAccessWatch();

  // Once, at boot, rather than on a timer: it is a migration, not a sweep. A
  // SQL migration could not do it -- the key lives in the environment, which
  // is the property that makes a leaked dump worthless -- and it cannot be
  // lazy-on-read either, because reads do not write and a project nobody
  // opens would keep its secrets in the clear indefinitely.
  void backfillSealedEnvVars().catch((error: unknown) => {
    logger.error("could not seal environment variables", error);
  });

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

  if (previewPort !== 0) listenForPreviews(previewServer, previewPort);
  if (deployPort !== 0) listenForSites(deploySiteServer, deployPort);
}

/** Reports a fatal startup failure and exits.
 *
 *  `start` no longer lets Docker stop it reaching `listen` — a daemon that is
 *  down or slow is logged and survived, since the API is useful without it.
 *  What remains fatal is a failure to bind the port. Node exits on an unhandled
 *  rejection on its own; this only replaces a bare stack trace with a line
 *  saying which stage failed, which is the difference between a legible restart
 *  loop and a puzzling one.
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

  // Before the process goes. Closing the sockets above runs each disconnect
  // handler, but the flush inside those is not awaited by anything — so a
  // deploy used to drop whatever had been typed since the last debounce, with
  // no client-side copy to recover it from.
  await flushAllDocs().catch((error: unknown) => {
    logger.error("could not flush documents on shutdown", error);
  });
  await new Promise<void>((resolve) => {
    previewServer.close();
    deploySiteServer.close();

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
