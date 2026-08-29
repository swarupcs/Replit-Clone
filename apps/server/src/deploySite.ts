import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Agent, createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import path from "node:path";
import express, { type Request, type RequestHandler, type Response } from "express";
import helmet from "helmet";
import { createProxyMiddleware } from "http-proxy-middleware";
import { requestLogger } from "./middlewares/requestLogger.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { resolveSite } from "./service/deployService.js";
import { serviceTarget } from "./containers/deployContainer.js";
import { logger } from "./lib/logger.js";
import { increment } from "./lib/metrics.js";

/** The listener that serves published deployments, and nothing else.
 *
 *  This is the only origin in the product that answers a request from somebody
 *  with no account, no session and no invitation — which is exactly what makes
 *  a deployment worth having, and exactly why it gets a listener of its own
 *  rather than a route on one of the others.
 *
 *  It could not share the API's origin: a published site is arbitrary user
 *  code, and same-origin with the API it could mint itself a session from the
 *  refresh cookie. It could not share the PREVIEW origin either, which is the
 *  less obvious half — a preview is authenticated by a cookie scoped to that
 *  origin, so a public site sitting beside it would be same-origin with a page
 *  that carries a live preview credential. Three concerns, three origins.
 *
 *  Nothing here reads a cookie, and no cookie parser is installed. There is no
 *  identity on this origin to get wrong. A published app may set and read
 *  cookies of its own -- they belong to its subdomain and mean nothing to this
 *  server, which is exactly why it does not parse them.
 *
 *  Two kinds of site are served from here. A static one is files on disk and
 *  everything below about paths, traversal and hidden entries applies to it. A
 *  service one is a container, and none of it applies: the request is proxied
 *  whole and the app decides what its own paths mean.
 */

/** Content types by extension.
 *
 *  A fixed table rather than a lookup library: everything served here was
 *  produced by a build we know the shape of, and an unknown extension should
 *  download rather than be guessed at. Every response also carries `nosniff`,
 *  so a wrong guess could not be talked into executing anyway.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".zip": "application/zip",
};

function contentType(file: string): string {
  return (
    CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream"
  );
}

/** Whether a request path names a hidden file.
 *
 *  A build output is not always only the build's own work: Vite copies
 *  `public/` verbatim, so a stray `public/.env` would be published and, without
 *  this, served to anybody who guessed the name. `.well-known` is the one
 *  exception, because certificate issuance and app-association files live there
 *  by specification and are meant to be fetched.
 *
 *  Exported for the tests: this is a rule that must not quietly regress.
 */
export function isHiddenPath(pathname: string): boolean {
  return pathname
    .split("/")
    .some((segment) => segment.startsWith(".") && segment !== ".well-known");
}

/** Resolves a request path to a file inside one site's root, or undefined.
 *
 *  The pathname is attacker-controlled and percent-decoded here, so the
 *  containment check happens AFTER decoding and after `path.resolve` has
 *  collapsed every `..`. Exported because it is the boundary worth testing
 *  directly.
 */
export function resolveWithin(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape is not a path anybody meant.
    return undefined;
  }

  // A NUL truncates the path inside libuv, so a prefix check on the whole
  // string would not be checking what actually gets opened.
  if (decoded.includes("\0")) return undefined;

  // Backslashes are separators on Windows, so they have to be normalised
  // before the traversal check rather than after it.
  const normalized = decoded.replace(/\\/g, "/").replace(/^\/+/, "");
  const absolute = path.resolve(root, normalized);

  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    return undefined;
  }

  return absolute;
}

/** How long a browser may reuse a response.
 *
 *  Split by kind, because they are versioned differently. A bundler gives
 *  assets content-hashed names, so an old one is never asked for again and a
 *  long cache costs nothing; HTML keeps its name across every deploy, so
 *  caching it is how a redeploy fails to appear.
 */
function cacheControl(file: string): string {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".html" || extension === ".htm") return "no-cache";
  return "public, max-age=600";
}

async function serveFile(
  res: Response,
  file: string,
  status = 200,
): Promise<boolean> {
  const stats = await stat(file).catch(() => null);
  if (!stats?.isFile()) return false;

  res.status(status);
  res.setHeader("Content-Type", contentType(file));
  res.setHeader("Content-Length", stats.size);
  res.setHeader("Cache-Control", cacheControl(file));

  await new Promise<void>((resolve) => {
    const stream = createReadStream(file);
    stream.on("error", () => {
      // The file existed a moment ago; a redeploy may have replaced the tree
      // underneath this request. Nothing useful left to say — the headers have
      // already gone out.
      res.destroy();
      resolve();
    });
    stream.on("end", resolve);
    stream.pipe(res);
  });

  return true;
}

const NOT_FOUND_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Not found</title>
<style>:root{--bg:#ffffff;--fg:#131623;--muted:#4a5169}
@media (prefers-color-scheme:dark){:root{--bg:#0d0e16;--fg:#f2f3f7;--muted:#a2a7bd}}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;
place-items:center;min-height:100vh;margin:0;background:var(--bg);color:var(--fg);
text-align:center;padding:24px}
h1{font-size:19px;font-weight:600;margin:0 0 8px}
p{color:var(--muted);font-size:14px;margin:0}</style></head>
<body><div><h1>Nothing here</h1>
<p>There is no site at this address.</p></div></body></html>`;

function notFound(res: Response): void {
  res
    .status(404)
    .type("html")
    .setHeader("Cache-Control", "no-store");
  res.send(NOT_FOUND_HTML);
}

/** Target for the request currently being proxied.
 *
 *  A WeakMap keyed on the raw message rather than a property on `req`, for the
 *  same reason the preview proxy does it: an upgrade never becomes an Express
 *  request, and both paths have to look the answer up the same way.
 */
const serviceTargets = new WeakMap<IncomingMessage, string>();

const SERVICE_DOWN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Unavailable</title>
<style>:root{--bg:#ffffff;--fg:#131623;--muted:#4a5169}
@media (prefers-color-scheme:dark){:root{--bg:#0d0e16;--fg:#f2f3f7;--muted:#a2a7bd}}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;
place-items:center;min-height:100vh;margin:0;background:var(--bg);color:var(--fg);
text-align:center;padding:24px}
h1{font-size:19px;font-weight:600;margin:0 0 8px}
p{color:var(--muted);font-size:14px;margin:0}</style></head>
<body><div><h1>This app is not responding</h1>
<p>It was published, but nothing is answering right now.</p></div></body></html>`;

/** Reverse proxy for service deployments.
 *
 *  One connection per request, for the reason the preview proxy gives: a
 *  pooled socket to a container goes stale when Docker's backend pauses, and
 *  the next request over it dies with ECONNRESET -- which a visitor reads as
 *  the site being broken.
 */
function createServiceProxy(): RequestHandler & {
  upgrade: (req: Request, socket: Socket, head: Buffer) => void;
} {
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  return createProxyMiddleware<Request, Response>({
    router: (req) => serviceTargets.get(req) ?? "http://127.0.0.1:1",
    agent: new Agent({ keepAlive: false }),
    changeOrigin: true,
    // Off for the reason preview.ts documents at length: it would attach an
    // unfiltered upgrade handler to the whole server. Upgrades are handled
    // explicitly by `installServiceUpgrade` below.
    ws: false,
    on: {
      error: (error, _req, res) => {
        increment("deploy_service_proxy_errors");
        logger.warn("service deployment proxy error", {
          reason: error.message,
        });
        if ("writeHead" in res && !res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
          res.end(SERVICE_DOWN_HTML);
        }
      },
    },
  });
}

const serviceProxy = createServiceProxy();

function serviceUnavailable(res: Response): void {
  increment("deploy_service_unavailable");
  res.status(503).type("html").setHeader("Cache-Control", "no-store");
  res.send(SERVICE_DOWN_HTML);
}

/** Routes WebSocket upgrades to a published service.
 *
 *  A published app that uses a socket -- a chat, a live dashboard, anything
 *  built on one -- is not an edge case worth refusing. Nothing is authorised
 *  here because there is nothing to authorise: this origin is public, and the
 *  Host header is the whole of the routing decision.
 */
export function installServiceUpgrade(server: Server): void {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      try {
        const site = await resolveSite(req.headers.host ?? "");
        if (!site || site.kind !== "service" || site.port === null) {
          socket.destroy();
          return;
        }

        const target = await serviceTarget(site.subdomain, site.port);
        if (!target) {
          socket.destroy();
          return;
        }

        serviceTargets.set(req, target);
        serviceProxy.upgrade(req as Request, socket as Socket, head);
      } catch {
        socket.destroy();
      }
    })();
  });
}

export function createDeploySiteServer(): Server {
  const app = express();

  app.disable("x-powered-by");
  // The one header that matters here, and it is set on every response below
  // as well: a published site is untrusted content, and MIME sniffing is how a
  // .txt in an assets directory becomes a script.
  app.use(
    helmet({
      // A deployed site is an arbitrary user app; helmet's CSP and COEP
      // defaults would break it, and they are not ours to impose on somebody
      // else's page.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: false,
      // A published page may legitimately want to be embedded — that is what
      // publishing it is for.
      frameguard: false,
    }),
  );

  app.use(requestLogger);

  // No cookie parser and no CORS, deliberately. There is no identity on this
  // origin, so there is nothing for either to do except create a way to be
  // wrong about it.

  // Every method, not only GET. A static site still answers nothing else --
  // the check moved below, after the site is resolved -- but a published API
  // exists to be POSTed to, and refusing before knowing which kind of site
  // this is would have made every service deployment read-only.
  app.all(/.*/, (req: Request, res: Response, next) => {
    void (async () => {
      try {

        const site = await resolveSite(req.hostname || req.headers.host || "");
        if (!site) {
          notFound(res);
          return;
        }

        // A service deployment is a container, not a directory. None of the
        // path handling below applies: the app owns its own routing, its own
        // 404s and its own idea of what an extension means.
        if (site.kind === "service") {
          if (site.port === null) {
            serviceUnavailable(res);
            return;
          }

          const target = await serviceTarget(site.subdomain, site.port);
          if (!target) {
            // Published, but nothing running behind it -- crashed, or the
            // host restarted and has not brought it back yet. A 503 rather
            // than a 404, because the address IS a site; it is the app that
            // is missing.
            serviceUnavailable(res);
            return;
          }

          serviceTargets.set(req, target);
          serviceProxy(req, res, next);
          return;
        }

        if (req.method !== "GET" && req.method !== "HEAD") {
          notFound(res);
          return;
        }

        const pathname = req.path;
        if (isHiddenPath(pathname)) {
          notFound(res);
          return;
        }

        const resolved = resolveWithin(site.root, pathname);
        if (!resolved) {
          increment("deploy_site_traversal_blocked");
          notFound(res);
          return;
        }

        // A directory is addressed by its index, the convention every static
        // host follows. Listing it instead would publish the shape of a tree
        // the author only meant to publish the contents of.
        const stats = await stat(resolved).catch(() => null);
        const target = stats?.isDirectory()
          ? path.join(resolved, "index.html")
          : resolved;

        if (await serveFile(res, target)) return;

        // Client-side routing: an app that owns /about has no about.html to
        // serve, and the router in index.html is what knows the route exists.
        // Only for requests that wanted a page — a missing image or script must
        // stay a 404, or a broken asset silently becomes a copy of the HTML and
        // fails much later and much less legibly.
        if (wantsHtml(req) && path.extname(pathname) === "") {
          if (await serveFile(res, path.join(site.root, "index.html"))) return;
        }

        notFound(res);
      } catch (error) {
        next(error);
      }
    })();
  });

  app.use(errorHandler);

  return createServer(app);
}

/** Whether this request was a navigation rather than a subresource. */
function wantsHtml(req: Request): boolean {
  const dest = req.headers["sec-fetch-dest"];
  if (dest === "document" || dest === "iframe") return true;
  // Older browsers and curl send no Fetch metadata; Accept is what remains.
  if (dest !== undefined) return false;
  return (req.headers.accept ?? "").includes("text/html");
}

/** Binds the deploy listener, retrying a port the previous process has not let
 *  go of yet — `tsx watch` restarts race that on Windows. */
export function listenForSites(server: Server, port: number): void {
  let attemptsLeft = 10;

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE" || attemptsLeft-- <= 0) {
      logger.error("deploy site server listen failed", error);
      return;
    }
    setTimeout(() => server.listen(port), 300);
  });

  server.listen(port, () => {
    logger.info("deploy site server listening", { port });
  });
}
