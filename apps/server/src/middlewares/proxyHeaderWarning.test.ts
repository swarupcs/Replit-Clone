import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyHeaderWarning } from "./proxyHeaderWarning.js";
import { logger } from "../lib/logger.js";

/** plan.md §11.5. The runtime half of the exposure check.
 *
 *  `config/exposure.ts` can only guess at boot — a plain-HTTP proxy on a LAN
 *  looks exactly like no proxy at all. A forwarded header arriving is not a
 *  guess, and this says so once.
 */

function run(
  middleware: ReturnType<typeof proxyHeaderWarning>,
  headers: Record<string, string>,
): void {
  const next = vi.fn();
  middleware({ headers } as unknown as Request, {} as Response, next);
  expect(next).toHaveBeenCalled();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("when nothing is in front", () => {
  it("says nothing about an ordinary request", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    run(proxyHeaderWarning(0), { host: "localhost:3000" });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("when something is forwarding and nobody said so", () => {
  it("warns on X-Forwarded-For", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    run(proxyHeaderWarning(0), { "x-forwarded-for": "203.0.113.7" });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/TRUSTED_PROXY_HOPS is 0/);
  });

  it("warns on the RFC 7239 Forwarded header too", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    run(proxyHeaderWarning(0), { forwarded: "for=203.0.113.7" });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  /** Once. This fires on traffic, so a line per request would bury the log it
   *  is trying to be noticed in. */
  it("says it once and not per request", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const middleware = proxyHeaderWarning(0);

    run(middleware, { "x-forwarded-for": "203.0.113.7" });
    run(middleware, { "x-forwarded-for": "203.0.113.8" });
    run(middleware, { "x-forwarded-for": "203.0.113.9" });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  /** The header carries client addresses. This line reports a
   *  misconfiguration, not who was behind it, so the value is named rather
   *  than logged. */
  it("names the header without logging what was in it", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    run(proxyHeaderWarning(0), { "x-forwarded-for": "203.0.113.7" });

    expect(JSON.stringify(warn.mock.calls[0])).not.toContain("203.0.113.7");
  });
});

describe("when the deployment is configured", () => {
  it("stays quiet, and does no per-request work", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    run(proxyHeaderWarning(1), { "x-forwarded-for": "203.0.113.7" });

    expect(warn).not.toHaveBeenCalled();
  });
});
