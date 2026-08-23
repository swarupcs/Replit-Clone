import { createServer, type Server } from "node:http";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { installPreviewUpgrade, previewGuard } from "./routes/preview.js";
import type { PreviewProxy } from "./routes/preview.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { requestLogger } from "./middlewares/requestLogger.js";
import { logger } from "./lib/logger.js";

/** The listener that serves project previews, and nothing else.
 *
 *  Previews used to be mounted on the API's own app, so a project's app was
 *  framed from the API's origin. That is the least safe arrangement — the
 *  project's code, and every dependency it installs, would run same-origin with
 *  the API and could mint itself a session from the refresh cookie — so the
 *  editor withheld `allow-same-origin` from the iframe to stop it.
 *
 *  Which broke previews outright. A frame without `allow-same-origin` has an
 *  OPAQUE origin, and `<script type="module">` is always fetched in CORS mode:
 *  the requests went out as `Origin: null`, the API answered
 *  `Access-Control-Allow-Origin: <the editor's origin>`, and the browser
 *  blocked every module in the page. The HTML arrived, nothing in it ran, and
 *  a client-rendered app showed a white pane. A server-rendered one (Next)
 *  showed its markup and looked like it worked, which is what made this so
 *  slippery.
 *
 *  Giving previews a listener of their own resolves both at once: the frame has
 *  a real origin, so it can be granted `allow-same-origin`, and everything it
 *  loads is then same-origin with it and involves no CORS at all. The API is
 *  behind an origin boundary rather than behind a sandbox flag.
 *
 *  Only the preview route is mounted here. That is the entire point — an origin
 *  that also served /api would give back exactly what this separates.
 */
export function createPreviewServer(previewProxy: PreviewProxy): Server {
  const app = express();

  app.use(
    helmet({
      // A preview is an arbitrary user app. Helmet's default CSP and COEP would
      // break it, and the preview route sets its own CSP anyway.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      // Framed by the editor, which is a different origin by design.
      crossOriginResourcePolicy: false,
    }),
  );

  // No `cors` middleware, deliberately. Everything a preview loads is
  // same-origin with the preview document, so there is no cross-origin request
  // to allow — and an allowlist naming the editor's origin is what blocked
  // these responses in the first place.
  app.use(cookieParser());
  app.use(requestLogger);

  app.use("/preview/:projectId", previewGuard, previewProxy);

  // Anything else on this origin is not a preview. Said plainly, because an
  // API call landing here is a misconfiguration worth seeing rather than a
  // mysterious 404 from a route that does not exist.
  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      code: "NOT_FOUND",
      message: "This origin serves project previews only.",
    });
  });

  app.use(errorHandler);

  const server = createServer(app);

  // Vite's HMR socket rides the preview path, and Express middleware does not
  // run for upgrades — so this authorises and routes them itself.
  installPreviewUpgrade(server, previewProxy);

  // Node only destroys an upgrade when NOTHING is listening for one. A handler
  // is registered above and returns silently for paths it does not own, so
  // without this an upgrade to anything else would be accepted and then left
  // open until the OS timed it out.
  server.on("upgrade", (req, socket) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path.startsWith("/preview/")) return;
    if (socket.destroyed) return;

    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });

  return server;
}

/** Binds the preview server, retrying a port the previous process has not let
 *  go of yet — `tsx watch` restarts race that on Windows. */
export function listenForPreviews(server: Server, port: number): void {
  let attemptsLeft = 10;

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE" || attemptsLeft-- <= 0) {
      logger.error("preview server listen failed", error);
      return;
    }
    setTimeout(() => server.listen(port), 300);
  });

  server.listen(port, () => {
    logger.info("preview server listening", { port });
  });
}
