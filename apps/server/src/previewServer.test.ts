import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Request, RequestHandler, Response } from "express";

/** The preview listener exists to put previews on an origin of their own. What
 *  matters is therefore what it does NOT serve, and what headers it does not
 *  attach — both of which are the reasons previews were broken. */

vi.mock("./routes/preview.js", () => ({
  // Stands in for the proxy: answers with something identifiable so the route
  // can be seen to have been reached.
  previewGuard: ((_req, _res, next) => next()) as RequestHandler,
  installPreviewUpgrade: () => undefined,
}));

const { createPreviewServer } = await import("./previewServer.js");

const proxy = ((_req: Request, res: Response) => {
  res.type("html").send("<html>the project's app</html>");
}) as unknown as Parameters<typeof createPreviewServer>[0];

const PROJECT = "7e1c4b02-9a3d-4f18-8b6e-2d5a7c9e0f31";

describe("what the preview origin serves", () => {
  it("serves a project's preview", async () => {
    const response = await request(createPreviewServer(proxy)).get(
      `/preview/${PROJECT}/`,
    );

    expect(response.status).toBe(200);
    expect(response.text).toContain("the project's app");
  });

  /** The whole point of the separate origin. An origin that also served the
   *  API would hand back exactly the same-origin access it exists to remove. */
  it("does not serve the API", async () => {
    const response = await request(createPreviewServer(proxy)).get(
      "/api/v1/projects",
    );

    expect(response.status).toBe(404);
  });

  it("does not serve the health endpoints either", async () => {
    for (const path of ["/health", "/ping", "/api/v1/metrics"]) {
      const response = await request(createPreviewServer(proxy)).get(path);
      expect(response.status).toBe(404);
    }
  });
});

/** The defect that made this listener necessary.
 *
 *  A preview frame without `allow-same-origin` has an opaque origin, and
 *  `<script type="module">` is always fetched in CORS mode — so the API's
 *  `Access-Control-Allow-Origin: <editor origin>` matched nothing and the
 *  browser blocked every module in the page. On its own origin the frame's
 *  requests are same-origin, so there is no CORS step to fail, and an
 *  allowlist naming some other origin would only reintroduce one.
 */
describe("cross-origin headers", () => {
  it("attaches no allowlist that a preview's own requests could fail", async () => {
    const response = await request(createPreviewServer(proxy))
      .get(`/preview/${PROJECT}/@vite/client`)
      .set("origin", "null");

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  /** Helmet's default `X-Frame-Options: SAMEORIGIN` says the preview may not
   *  be framed by another origin — which is the one thing it exists to be. A
   *  browser is meant to ignore it when CSP `frame-ancestors` is also present,
   *  and the preview route sets that, but a header stating the opposite of
   *  what is wanted should not be sent on the strength of a precedence rule. */
  it("does not tell the browser it may not be framed", async () => {
    const response = await request(createPreviewServer(proxy)).get(
      `/preview/${PROJECT}/`,
    );

    expect(response.headers["x-frame-options"]).toBeUndefined();
  });

  /** Helmet's default would set `Cross-Origin-Resource-Policy: same-origin`,
   *  which stops the editor framing the preview at all. */
  it("does not block being framed by the editor", async () => {
    const response = await request(createPreviewServer(proxy)).get(
      `/preview/${PROJECT}/`,
    );

    expect(response.headers["cross-origin-resource-policy"]).toBeUndefined();
  });
});
