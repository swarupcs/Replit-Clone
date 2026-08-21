import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.hoisted(() => vi.fn());
const checkDocker = vi.hoisted(() => vi.fn());
const snapshot = vi.hoisted(() => vi.fn(() => ({ terminal_sessions: 3 })));

vi.mock("../lib/prisma.js", () => ({ prisma: { $queryRaw: queryRaw } }));
vi.mock("../containers/containerManager.js", () => ({ checkDocker }));
vi.mock("../lib/metrics.js", () => ({ snapshot, increment: vi.fn() }));

import { healthCheck, metricsReport } from "./healthController.js";
import { apiApp, bearer } from "../test/apiHarness.js";

const publicApp = apiApp(
  [{ method: "get", path: "/health", handler: healthCheck }],
  { auth: false },
);

const authedApp = apiApp([{ method: "get", path: "/metrics", handler: metricsReport }]);

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  checkDocker.mockResolvedValue(undefined);
});

describe("healthCheck", () => {
  it("reports ok with 200 when both dependencies answer", async () => {
    const response = await request(publicApp).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.checks.database.ok).toBe(true);
    expect(response.body.checks.docker.ok).toBe(true);
    expect(typeof response.body.uptimeSeconds).toBe("number");
  });

  it("times each dependency separately", async () => {
    const response = await request(publicApp).get("/health");

    expect(typeof response.body.checks.database.latencyMs).toBe("number");
    expect(typeof response.body.checks.docker.latencyMs).toBe("number");
  });

  /** 503 rather than a 200 with a sad body, so a load balancer or a container
   *  healthcheck can act on it without parsing anything. */
  it("answers 503 when Postgres is unreachable", async () => {
    queryRaw.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const response = await request(publicApp).get("/health");

    expect(response.status).toBe(503);
    expect(response.body.status).toBe("degraded");
    expect(response.body.checks.database).toMatchObject({
      ok: false,
      error: "connect ECONNREFUSED",
    });
    // The other dependency is still reported honestly.
    expect(response.body.checks.docker.ok).toBe(true);
  });

  it("answers 503 when the Docker daemon is down", async () => {
    checkDocker.mockRejectedValue(new Error("daemon not running"));

    const response = await request(publicApp).get("/health");

    expect(response.status).toBe(503);
    expect(response.body.checks.docker).toMatchObject({
      ok: false,
      error: "daemon not running",
    });
  });

  it("answers 503 when both are down", async () => {
    queryRaw.mockRejectedValue(new Error("db"));
    checkDocker.mockRejectedValue(new Error("docker"));

    const response = await request(publicApp).get("/health");

    expect(response.status).toBe(503);
    expect(response.body.checks.database.ok).toBe(false);
    expect(response.body.checks.docker.ok).toBe(false);
  });

  it("describes a non-Error rejection rather than dropping it", async () => {
    checkDocker.mockRejectedValue("just a string");

    const response = await request(publicApp).get("/health");

    expect(response.body.checks.docker.error).toBe("just a string");
  });

  it("checks the two dependencies concurrently, not one after the other", async () => {
    let dockerStarted = false;
    let overlapped = false;

    checkDocker.mockImplementation(async () => {
      dockerStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    queryRaw.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      overlapped = dockerStarted;
      return [];
    });

    await request(publicApp).get("/health");

    expect(overlapped).toBe(true);
  });

  /** A probe cannot hold a credential, so this endpoint is open — which is
   *  exactly why it must never report how much is running here. */
  it("needs no credential, and reveals nothing about usage", async () => {
    const response = await request(publicApp).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty("counters");
    expect(JSON.stringify(response.body)).not.toContain("terminal_sessions");
  });
});

describe("metricsReport", () => {
  it("returns the counters to a signed-in caller", async () => {
    const response = await request(authedApp)
      .get("/metrics")
      .set("Authorization", bearer());

    expect(response.status).toBe(200);
    expect(response.body.data.counters).toEqual({ terminal_sessions: 3 });
    expect(typeof response.body.data.memoryBytes).toBe("number");
  });

  /** They describe how busy the deployment is and what is failing, which is not
   *  for anyone who can reach the port. */
  it("is not readable without a credential", async () => {
    const response = await request(authedApp).get("/metrics");

    expect(response.status).toBe(401);
    expect(snapshot).not.toHaveBeenCalled();
  });
});
