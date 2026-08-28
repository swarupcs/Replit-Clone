import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { apiSecurityHeaders } from "./apiSecurityHeaders.js";

/** The API origin's framing and content policy.
 *
 *  The interesting case is not that the headers are set -- it is the ONE path
 *  that must not have them, and only under the one configuration that puts it
 *  on this origin. A blanket exemption is what this replaced.
 */

function app(previewsShareThisOrigin: boolean) {
  const server = express();
  server.use(apiSecurityHeaders(previewsShareThisOrigin));
  server.get("/api/v1/projects", (_req, res) => {
    res.json({ ok: true });
  });
  server.get("/preview/p1/index.html", (_req, res) => {
    res.send("<html lang='en'>a user's app</html>");
  });
  return server;
}

describe("the API's own responses", () => {
  it("refuse to be framed", async () => {
    const response = await request(app(false)).get("/api/v1/projects");

    expect(response.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });

  it("declare that they load nothing", async () => {
    // Safe here in a way it would not be almost anywhere else: nothing this
    // origin serves is a document. The one endpoint returning bytes forces
    // `attachment` with `nosniff`, so it is downloaded, not rendered.
    const response = await request(app(false)).get("/api/v1/projects");

    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
  });

  it("say DENY rather than helmet's SAMEORIGIN", async () => {
    // Nothing frames the API, this app included.
    const response = await request(app(false)).get("/api/v1/projects");

    expect(response.headers["x-frame-options"]).not.toBe("SAMEORIGIN");
  });
});

describe("previews, when they share this origin", () => {
  it("are exempt, because they are somebody else's app", async () => {
    // `default-src 'none'` on a user's dev server is a blank page. This is the
    // reason the whole server had no policy before, and the reason the
    // exemption still has to exist -- narrowed to the path that needs it.
    const response = await request(app(true)).get("/preview/p1/index.html");

    expect(response.headers["content-security-policy"]).toBeUndefined();
    expect(response.headers["x-frame-options"]).toBeUndefined();
  });

  it("do not exempt the rest of the API alongside them", async () => {
    const response = await request(app(true)).get("/api/v1/projects");

    expect(response.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });
});

describe("previews, when they have an origin of their own", () => {
  it("claim no exemption here at all", async () => {
    // With PREVIEW_PORT set, /preview on the API is not a preview -- it is a
    // path a caller made up, and it gets the API's policy like anything else.
    const response = await request(app(false)).get("/preview/p1/index.html");

    expect(response.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });
});
