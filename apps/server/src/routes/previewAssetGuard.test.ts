import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

/** The fallback that serves a root-relative asset for the preview above it.
 *
 *  Without it, stripping the preview prefix does not work for any app that
 *  emits absolute asset URLs — which is Next's `/_next/...`, a Flask app's
 *  `/static/...`, and a Go server's `/assets/...`. Their page loads under
 *  `/preview/<id>/` and every asset on it is then requested at the origin
 *  root, where the only thing listening said "this origin serves previews".
 *
 *  Half of these are refusals, and that is the right emphasis: it runs on
 *  every request this origin cannot otherwise answer.
 */

/** Mocked at the level `authorisePreview` actually depends on, rather than by
 *  spying on `authorisePreview` itself.
 *
 *  The first draft did the latter and three tests failed: the guard calls it
 *  through the module's own binding, which a spy on the namespace object never
 *  sees. Worse, one REFUSAL test passed while it was broken -- the real check
 *  rejected a token the fake never issued, so the guard declined for a reason
 *  the test was not about. A refusal test that cannot distinguish "refused for
 *  my reason" from "refused for any reason" is not testing anything. */
const access = vi.hoisted(() => vi.fn());
const verify = vi.hoisted(() => vi.fn());
const resolve = vi.hoisted(() => vi.fn());
const ensure = vi.hoisted(() => vi.fn());

vi.mock("../lib/prisma.js", () => ({
  prisma: { project: { findUnique: vi.fn() } },
}));
vi.mock("../service/projectService.js", () => ({ assertProjectAccess: access }));
vi.mock("../containers/containerManager.js", () => ({
  ensureContainer: ensure,
  getPreviewTarget: resolve,
}));
vi.mock("../service/tokenService.js", () => ({
  PREVIEW_COOKIE_NAME: "preview_token",
  verifyPreviewToken: verify,
}));
vi.mock("../service/hmrSockets.js", () => ({
  noteHmrClosed: vi.fn(),
  noteHmrOpen: vi.fn(),
}));

const { createPreviewAssetRoute } = await import("./preview.js");

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const HOST = "preview.example.com:3101";

function run(options: {
  referer?: string;
  host?: string;
  url?: string;
}): Promise<{
  next: NextFunction;
  setHeader: ReturnType<typeof vi.fn>;
  proxied: ReturnType<typeof vi.fn>;
}> {
  const req = {
    url: options.url ?? "/_next/static/chunks/main.js",
    headers: {
      host: "host" in options ? options.host : HOST,
      referer: options.referer,
    },
    cookies: { preview_token: "a-token" },
  } as unknown as Request;

  const setHeader = vi.fn();
  const res = { setHeader } as unknown as Response;
  const next = vi.fn();

  // Serving means calling the proxy; declining means calling next(). Asserting
  // on which of the two happened is the point -- an earlier draft chained the
  // two in one `app.use`, where declining fell INTO the proxy and every
  // unidentifiable request was answered 502 instead of 404.
  const proxied = vi.fn();
  const route = createPreviewAssetRoute(
    proxied as unknown as Parameters<typeof createPreviewAssetRoute>[0],
  );

  route(req, res, next);
  // The route's body is async and finishes from inside it.
  return new Promise((done) => {
    setTimeout(
      () => done({ next: next as unknown as NextFunction, setHeader, proxied }),
      0,
    );
  });
}

beforeEach(() => {
  verify.mockReset().mockReturnValue({ sub: "a-user" });
  access.mockReset().mockResolvedValue(undefined);
  ensure.mockReset().mockResolvedValue(undefined);
  resolve.mockReset().mockResolvedValue("http://172.17.0.2:3000");
});

describe("what it will answer for", () => {
  it("serves an absolute asset for the preview that asked for it", async () => {
    const { next } = await run({
      referer: `http://${HOST}/preview/${PROJECT}/`,
    });
    const { proxied } = await run({
      referer: `http://${HOST}/preview/${PROJECT}/`,
    });

    expect(verify).toHaveBeenCalledWith("a-token");
    expect(access).toHaveBeenCalledWith(PROJECT, "a-user", "viewer");
    expect(proxied).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  /** The page it belongs to chose the port; the asset request carries no query
   *  of its own to say so. */
  it("takes the port from the page's own url", async () => {
    await run({ referer: `http://${HOST}/preview/${PROJECT}/?port=8080` });

    expect(resolve).toHaveBeenCalledWith(PROJECT, 8080);
  });

  /** Ours, never the dev server's — the same reassertion the ordinary route
   *  makes, because this response is a subresource of a framed document. */
  it("sets this platform's own CSP", async () => {
    // The spy itself, handed back by `run`: reaching for it through `res`
    // reads as an unbound method however it is accessed.
    const { setHeader } = await run({
      referer: `http://${HOST}/preview/${PROJECT}/`,
    });

    expect(setHeader).toHaveBeenCalledWith(
      "Content-Security-Policy",
      expect.stringContaining("frame-ancestors"),
    );
  });
});

describe("what it refuses to guess at", () => {
  /** Falling through means the 404 that says this origin serves previews,
   *  which is the correct answer for a request that is not one. */
  it("declines a request with no Referer at all", async () => {
    const { next, proxied } = await run({});

    expect(access).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
    expect(proxied).not.toHaveBeenCalled();
  });

  /** A Referer from anywhere else is not a preview page of ours, whatever its
   *  path happens to spell. */
  it("declines a cross-origin Referer that names a real project", async () => {
    const { next, proxied } = await run({
      referer: `https://evil.example.com/preview/${PROJECT}/`,
    });

    expect(access).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
    expect(proxied).not.toHaveBeenCalled();
  });

  it("declines a Referer that is not a url", async () => {
    const { next, proxied } = await run({ referer: "not a url" });

    expect(access).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
    expect(proxied).not.toHaveBeenCalled();
  });

  it("declines a same-origin Referer with no project in its path", async () => {
    const { next, proxied } = await run({ referer: `http://${HOST}/dashboard` });

    expect(access).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
    expect(proxied).not.toHaveBeenCalled();
  });

  /** The Referer selects; it never authorises. A forged one reaches only a
   *  project the cookie already opens. */
  it("declines when the cookie does not authorise that project", async () => {
    access.mockRejectedValue(new Error("nope"));

    const { next, proxied } = await run({ referer: `http://${HOST}/preview/${PROJECT}/` });

    expect(next).toHaveBeenCalledWith();
    expect(proxied).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  /** A dev server that is not listening is not an error worth explaining on
   *  an asset request. */
  it("declines when nothing is listening", async () => {
    resolve.mockResolvedValue(undefined);

    const { next, proxied } = await run({ referer: `http://${HOST}/preview/${PROJECT}/` });

    expect(next).toHaveBeenCalledWith();
    expect(proxied).not.toHaveBeenCalled();
  });

  it("declines when the host header is missing", async () => {
    const { next, proxied } = await run({
      host: undefined,
      referer: `http://${HOST}/preview/${PROJECT}/`,
    });

    expect(access).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
    expect(proxied).not.toHaveBeenCalled();
  });
});
