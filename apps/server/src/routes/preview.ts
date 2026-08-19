import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import {
  ensureContainer,
  getPreviewTarget,
} from "../containers/containerManager.js";
import { assertProjectAccess } from "../service/projectService.js";
import { PREVIEW_COOKIE_NAME, verifyPreviewToken } from "../service/tokenService.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import { UnauthorizedError } from "../utils/errors.js";

/** Resolves the project's dev server address. The port comes from the
 *  template, which is why 5173 is no longer hardcoded in four places. */
async function resolveTarget(projectId: string): Promise<string | undefined> {
  return getPreviewTarget(projectId);
}

/** Authorises a preview request from the `preview_token` cookie.
 *
 *  The preview is loaded in an iframe and its HMR socket is opened by Vite's
 *  own client, so neither can attach an Authorization header — a cookie scoped
 *  to /preview is the only credential both carry. It is SameSite=Lax, so an
 *  unrelated site cannot frame the preview and have the cookie sent.
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
      next();
    } catch (error) {
      next(error);
    }
  })();
}

const DEV_SERVER_DOWN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Preview unavailable</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;
min-height:100vh;margin:0;background:#282a36;color:#f8f8f2}
code{background:#44475a;padding:2px 6px;border-radius:4px}</style></head>
<body><div><h1>Nothing running yet</h1>
<p>Start your dev server in the terminal, then reload:</p>
<p><code>npm install &amp;&amp; npm run dev</code></p></div></body></html>`;

/** Target resolved by the guard, handed to the proxy for the same request.
 *  A WeakMap keeps it off `req` and lets it be collected with the request. */
const targets = new WeakMap<Request, string>();

/** Reverse proxy for project previews.
 *
 *  Replaces publishing a random HOST port per container and pointing an iframe
 *  at http://localhost:<port>, which only worked when the backend ran on the
 *  viewer's own machine and opened one host port per project. Containers now
 *  publish nothing at all.
 */
export function createPreviewProxy(): RequestHandler {
  return createProxyMiddleware<Request, Response>({
    router: (req) => targets.get(req) ?? "http://127.0.0.1:1",
    changeOrigin: true,
    // Vite's HMR socket rides this same path.
    ws: true,
    // Express strips the mount prefix from req.url, but the dev server is
    // configured with base=/preview/<id>/ and expects to SEE that prefix, so
    // the original path is restored rather than rewritten away.
    pathRewrite: (_pathname, req) => req.originalUrl,
    on: {
      error: (error, _req, res) => {
        console.error("Preview proxy error:", error.message);
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

export { PREVIEW_COOKIE_NAME };
