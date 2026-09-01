import request from "supertest";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The endpoint a TLS terminator asks before it will issue a certificate.
 *
 *  §3.3 carried this row as blocked infrastructure, and the decision that
 *  unblocks most of it is a refusal to write an ACME client: the proxy this
 *  deployment runs anyway does the account key, the challenge, the store and
 *  the renewal, and the only thing it needs from us is whether a hostname is
 *  real. That question was already answered by `resolveCustomDomain`.
 *
 *  Which leaves this route as the guard between a public listener and
 *  unbounded certificate issuance, so its whole content is what it refuses and
 *  how little it says while refusing.
 */

const resolveCustomDomain = vi.hoisted(() => vi.fn());
vi.mock("../../service/customDomainService.js", () => ({ resolveCustomDomain }));
vi.mock("../../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import tlsRouter from "./tls.js";
import { errorHandler } from "../../middlewares/errorHandler.js";

function app() {
  const instance = express();
  // Mounted with NO auth, exactly as it is in the real router: the proxy asks
  // before any session exists. If that ever changes, this test is where it
  // shows up as a 401 rather than as certificates silently not being issued.
  instance.use("/tls", tlsRouter);
  instance.use(errorHandler);
  return instance;
}

const ask = (query: string) => request(app()).get(`/tls/authorize${query}`);

beforeEach(() => {
  vi.clearAllMocks();
  resolveCustomDomain.mockResolvedValue({ subdomain: "quiet-fern-84f1" });
});

describe("a hostname this platform serves", () => {
  it("is authorized, with no session and no key", async () => {
    const response = await ask("?domain=app.example.com");

    expect(response.status).toBe(200);
    expect(resolveCustomDomain).toHaveBeenCalledWith("app.example.com");
  });

  /** A body is a hostname oracle. The proxy reads the status code and nothing
   *  else, so anything in the body is information given away for free. */
  it("says nothing beyond the status", async () => {
    const response = await ask("?domain=app.example.com");

    expect(response.text).toBe("");
  });
});

describe("a hostname it does not", () => {
  /** One answer for "never heard of it", "claimed but never verified" and
   *  "verified and the record went away". Distinguishing them would tell an
   *  anonymous caller which domains somebody has claimed here. */
  it("is refused with nothing to learn from", async () => {
    resolveCustomDomain.mockResolvedValue(undefined);

    const response = await ask("?domain=not-ours.example.com");

    expect(response.status).toBe(404);
    expect(response.text).toBe("");
  });

  it("refuses a request with no domain at all", async () => {
    const response = await ask("");

    expect(response.status).toBe(404);
    // Not even asked: an empty hostname is not a question worth a query.
    expect(resolveCustomDomain).not.toHaveBeenCalled();
  });

  it("refuses a domain sent as something other than a string", async () => {
    // `?domain=a&domain=b` arrives as an array, which is the shape that turns
    // a careless handler into a type error at the database instead of a 404.
    const response = await ask("?domain=a.example.com&domain=b.example.com");

    expect(response.status).toBe(404);
    expect(resolveCustomDomain).not.toHaveBeenCalled();
  });
});
