import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestLogger } from "./requestLogger.js";
import { currentRequestId, logger } from "../lib/logger.js";

const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);

beforeEach(() => {
  info.mockClear();
  error.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Routes that answer with whatever status the caller asks for, so each test
 *  can drive the branch it cares about. */
function app() {
  const instance = express();

  instance.use(requestLogger);

  instance.get("/health", (req, res) => {
    res.status(Number(req.query["status"] ?? 200)).end();
  });
  instance.get("/ping", (_req, res) => {
    res.end();
  });
  instance.get("/preview/abc/index.html", (req, res) => {
    res.status(Number(req.query["status"] ?? 200)).end();
  });
  instance.get("/api/v1/projects", (req, res) => {
    // Echoed so a test can prove the id in the log is the id the handler saw.
    res.status(Number(req.query["status"] ?? 200)).json({ id: currentRequestId() });
  });

  return instance;
}

/** The fields object from the single `logger.info("request", …)` call. */
function loggedFields(): Record<string, unknown> {
  expect(info).toHaveBeenCalledOnce();
  return info.mock.calls[0]?.[1] as Record<string, unknown>;
}

describe("requestLogger", () => {
  it("stamps every response with an X-Request-Id", async () => {
    const response = await request(app()).get("/api/v1/projects");

    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f-]{36}$/i,
    );
  });

  it("honours an inbound X-Request-Id so one id spans several services", async () => {
    const response = await request(app())
      .get("/api/v1/projects")
      .set("X-Request-Id", "upstream-abc-123");

    expect(response.headers["x-request-id"]).toBe("upstream-abc-123");
    expect(loggedFields()).toMatchObject({ path: "/api/v1/projects" });
  });

  it("mints its own id when the inbound one is absurdly long", async () => {
    const overlong = "x".repeat(201);
    const response = await request(app())
      .get("/api/v1/projects")
      .set("X-Request-Id", overlong);

    expect(response.headers["x-request-id"]).not.toBe(overlong);
    expect(response.headers["x-request-id"]).toHaveLength(36);
  });

  it("makes the id readable from inside the handler", async () => {
    const response = await request(app()).get("/api/v1/projects");

    // The whole point of the AsyncLocalStorage context: a log line written deep
    // inside a service carries the same id the client was given.
    expect(response.body.id).toBe(response.headers["x-request-id"]);
  });

  it("logs an ordinary request once, with method, path, status and duration", async () => {
    await request(app()).get("/api/v1/projects");

    expect(info).toHaveBeenCalledWith("request", expect.anything());
    expect(loggedFields()).toMatchObject({
      method: "GET",
      path: "/api/v1/projects",
      status: 200,
    });
    expect(typeof loggedFields()["durationMs"]).toBe("number");
    expect(error).not.toHaveBeenCalled();
  });

  it.each(["/health", "/ping", "/preview/abc/index.html"])(
    "stays quiet about a successful %s",
    async (path) => {
      await request(app()).get(path);

      expect(info).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    },
  );

  it.each(["/health", "/preview/abc/index.html"])(
    "still reports %s when it fails",
    async (path) => {
      await request(app()).get(path).query({ status: 503 });

      // Quiet means quiet about the noise, not about the failures — a preview
      // returning 502 all day is exactly what needs to be visible.
      expect(error).toHaveBeenCalledWith(
        "request failed",
        undefined,
        expect.objectContaining({ status: 503 }),
      );
    },
  );

  it("logs a 5xx as an error and a 4xx as info", async () => {
    await request(app()).get("/api/v1/projects").query({ status: 500 });
    expect(error).toHaveBeenCalledOnce();
    expect(info).not.toHaveBeenCalled();

    error.mockClear();
    await request(app()).get("/api/v1/projects").query({ status: 403 });
    expect(error).not.toHaveBeenCalled();
    expect(loggedFields()).toMatchObject({ status: 403 });
  });
});
