import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import {
  ensureContainer,
  getPreviewTarget,
} from "../containers/containerManager.js";
import { prisma } from "../lib/prisma.js";
import { assertProjectAccess } from "../service/projectService.js";
import { getTemplate } from "../templates/registry.js";
import { PREVIEW_COOKIE_NAME, verifyPreviewToken } from "../service/tokenService.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import { UnauthorizedError } from "../utils/errors.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";

/** Resolves the project's dev server address. The port comes from the
 *  template, which is why 5173 is no longer hardcoded in four places. */
async function resolveTarget(projectId: string): Promise<string | undefined> {
  return getPreviewTarget(projectId);
}

async function expectsPreviewBase(projectId: string): Promise<boolean> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return false;
  return getTemplate(project.template).expectsPreviewBase;
}

/** Restricts who may frame a preview. `self` covers opening one in its own tab. */
const frameAncestors = `frame-ancestors 'self' ${env.WEB_ORIGIN}`;

/** Authorises a preview request from the `preview_token` cookie.
 *
 *  The preview is loaded in an iframe and its HMR socket is opened by Vite's
 *  own client, so neither can attach an Authorization header — a cookie scoped
 *  to /preview is the only credential both carry.
 */
export async function authorisePreview(
  projectId: string,
  cookieValue: string | undefined,
): Promise<void> {
  if (!cookieValue) throw new UnauthorizedError("No preview session");

  const { sub } = verifyPreviewToken(cookieValue);
  await assertProjectAccess(assertValidProjectId(projectId), sub);
}

/** Express guard: checks ownership, makes sure the container is running, and
 *  resolves the dev server address before the proxy tries to reach it. */
export function previewGuard(
  req: Request<{ projectId: string }>,
  res: Response,
  next: NextFunction,
): void {
  void (async () => {
    try {
      const projectId = assertValidProjectId(req.params.projectId);
      const cookies = req.cookies as Record<string, string> | undefined;

      // Only the editor may frame a preview. Helmet's CSP is switched off for
      // this route, and the comment below about SameSite=Lax stopping a
      // third-party frame does not hold in a split deployment, where the
      // cookie is deliberately SameSite=None so it can travel to the API host.
      res.setHeader("Content-Security-Policy", frameAncestors);

      await authorisePreview(projectId, cookies?.[PREVIEW_COOKIE_NAME]);
      await ensureContainer(projectId);

      const target = await resolveTarget(projectId);
      if (!target) {
        // The container is up but nothing is listening yet. An iframe deserves
        // a readable page rather than a JSON error body.
        res.status(502).type("html").send(DEV_SERVER_DOWN_HTML);
        return;
      }

      targets.set(req, target);
      keepsPrefix.set(req, await expectsPreviewBase(projectId));
      next();
    } catch (error) {
      next(error);
    }
  })();
}

const DEV_SERVER_DOWN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Preview unavailable</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;
place-items:center;min-height:100vh;margin:0;background:#0d0e16;color:#f2f3f7;
text-align:center;padding:24px}
h1{font-size:19px;font-weight:600;margin:0 0 8px}
p{color:#a2a7bd;font-size:14px;margin:0;line-height:1.6}
kbd{background:#232634;border:1px solid #303445;border-radius:6px;padding:2px 7px;
font-family:ui-monospace,monospace;font-size:13px}</style></head>
<body><div><h1>Nothing running yet</h1>
<p>Press <kbd>Run</kbd> in the toolbar to start the dev server,<br>
then reload this preview.</p></div></body></html>`;

/** Target resolved by the guard, handed to the proxy for the same request.
 *  A WeakMap keeps it off `req` and lets it be collected with the request.
 *  Keyed on IncomingMessage because a WebSocket upgrade never becomes an
 *  Express Request — see installPreviewUpgrade. */
const targets = new WeakMap<IncomingMessage, string>();

/** Whether this project's dev server expects to see the /preview/<id> prefix. */
const keepsPrefix = new WeakMap<IncomingMessage, boolean>();

/** Removes the viewer's credentials from a request on its way to the sandbox. */
function stripCredentials(proxyReq: {
  removeHeader: (name: string) => void;
}): void {
  proxyReq.removeHeader("cookie");
  proxyReq.removeHeader("authorization");
}

/** Reverse proxy for project previews.
 *
 *  Replaces publishing a random HOST port per container and pointing an iframe
 *  at http://localhost:<port>, which only worked when the backend ran on the
 *  viewer's own machine and opened one host port per project. Containers now
 *  publish nothing at all.
 */
export function createPreviewProxy(): PreviewProxy {
  // http-proxy-middleware's handler is declared as returning Promise<void>,
  // while Express's RequestHandler is declared as returning void. Express
  // ignores a handler's return value entirely, so the two are compatible in
  // practice and only the declarations disagree.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  return createProxyMiddleware<Request, Response>({
    router: (req) => targets.get(req) ?? "http://127.0.0.1:1",
    changeOrigin: true,
    // Vite's HMR socket rides this same path.
    ws: true,
    // Express already strips the mount prefix from req.url. Vite is configured
    // with base=/preview/<id>/ and expects to SEE that prefix, so for those
    // templates the original path is restored; every other dev server serves
    // from the root and gets the stripped path.
    //
    // An upgrade has no originalUrl, because Express never handled it — that
    // path normalises req.url itself before handing over.
    pathRewrite: (pathname, req) => {
      const original: string | undefined = req.originalUrl;
      if (original === undefined) return pathname;
      return keepsPrefix.get(req) ? original : pathname;
    },
    on: {
      // The guard has already authorised the request; the container never needs
      // the credential itself, and it is running code the platform treats as
      // untrusted. Forwarding the header verbatim handed every dependency in
      // the project a working preview cookie on every single request.
      proxyReq: stripCredentials,
      proxyReqWs: stripCredentials,
      // Reasserted here because the proxy copies the dev server's own headers
      // onto the response, which would otherwise replace ours.
      proxyRes: (proxyRes, _req, res) => {
        delete proxyRes.headers["content-security-policy"];
        delete proxyRes.headers["content-security-policy-report-only"];
        res.setHeader("Content-Security-Policy", frameAncestors);
      },
      error: (error, _req, res) => {
        increment("preview_errors");
        logger.warn("preview proxy error", { reason: error.message });
        if ("writeHead" in res && !res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            "<h1>Preview unavailable</h1>" +
              "<p>Start your dev server in the terminal, then reload.</p>",
          );
        }
      },
    },
  });
}

export function extractProjectId(urlOrPath: string): string | undefined {
  const match = /\/preview\/([0-9a-f-]{36})/i.exec(urlOrPath);
  return match?.[1];
}

/** The proxy middleware, which also exposes an upgrade handler. */
export type PreviewProxy = RequestHandler & {
  upgrade: (req: Request, socket: Socket, head: Buffer) => void;
};

/** Reads one cookie out of a raw header.
 *
 *  An upgrade never reaches Express, so `cookie-parser` has not run and
 *  `req.cookies` does not exist.
 */
function cookieFromHeader(header: string | undefined, name: string) {
  if (!header) return undefined;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;

    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      // A malformed value is simply not a usable credential.
      return undefined;
    }
  }

  return undefined;
}

/** Strips the `/preview/<id>` mount prefix from an upgrade's path.
 *
 *  Express does this for ordinary requests but never sees an upgrade, so a dev
 *  server that serves from the root would be asked for /preview/<id>/... and
 *  404. Collapses to "/" rather than "" when nothing follows the prefix, since
 *  a proxied request with no path at all is not a valid one.
 */
export function stripPreviewPrefix(
  pathname: string,
  search: string,
  projectId: string,
): string {
  const prefix = `/preview/${projectId}`;
  return `${pathname.slice(prefix.length) || "/"}${search}`;
}

/** Authorises and routes the preview's WebSocket upgrades.
 *
 *  Express middleware does not run for upgrades, so `previewGuard` never saw
 *  them: the proxy asked for a target that had never been recorded, fell back
 *  to its dead-end address, and Vite's HMR socket could not connect. The
 *  upgrade also skipped the ownership check entirely.
 *
 *  This owns the upgrade the same way the terminal gateway owns its own, and
 *  performs the identical checks the HTTP guard does before handing over.
 */
export function installPreviewUpgrade(
  server: Server,
  proxy: PreviewProxy,
): void {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // socket.io and the terminal gateway handle their own upgrades.
    if (!url.pathname.startsWith("/preview/")) return;

    void (async () => {
      try {
        const projectId = assertValidProjectId(
          extractProjectId(url.pathname) ?? "",
        );

        await authorisePreview(
          projectId,
          cookieFromHeader(req.headers.cookie, PREVIEW_COOKIE_NAME),
        );
        await ensureContainer(projectId);

        const target = await resolveTarget(projectId);
        if (!target) throw new Error("The dev server is not listening");

        const keepPrefix = await expectsPreviewBase(projectId);
        targets.set(req, target);
        keepsPrefix.set(req, keepPrefix);

        // Express strips the mount prefix on ordinary requests. Nothing does
        // for an upgrade, so a dev server that serves from the root would be
        // asked for /preview/<id>/... and 404.
        if (!keepPrefix) {
          req.url = stripPreviewPrefix(url.pathname, url.search, projectId);
        }

        proxy.upgrade(req as Request, socket as Socket, head);
      } catch (error) {
        increment("preview_upgrades_rejected");
        logger.warn("preview upgrade rejected", {
          reason: error instanceof Error ? error.message : String(error),
        });
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
      }
    })();
  });
}

export { PREVIEW_COOKIE_NAME };
