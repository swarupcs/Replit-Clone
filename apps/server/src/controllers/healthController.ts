import type { Request, Response } from "express";
import { checkDocker } from "../containers/containerManager.js";
import { prisma } from "../lib/prisma.js";
import { snapshot } from "../lib/metrics.js";

/** Health, meaning the dependencies without which nothing works.
 *
 *  `/ping` always returned 200 no matter what state the process was in — it
 *  checked neither Postgres nor the Docker daemon, so an orchestrator watching
 *  it would happily keep routing traffic to a server that could not serve a
 *  single request. It is kept for compatibility; this is the one to point a
 *  probe at.
 */

interface DependencyStatus {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

async function timed(check: () => Promise<unknown>): Promise<DependencyStatus> {
  const startedAt = process.hrtime.bigint();

  try {
    await check();
    return {
      ok: true,
      latencyMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Unauthenticated, because a probe cannot hold a credential. It therefore
 *  reports only whether each dependency answers — never how many users or
 *  projects exist, which is what /api/v1/metrics is for. */
export async function healthCheck(_req: Request, res: Response): Promise<void> {
  const [database, docker] = await Promise.all([
    timed(() => prisma.$queryRaw`SELECT 1`),
    timed(() => checkDocker()),
  ]);

  const ok = database.ok && docker.ok;

  // 503 when a dependency is down, so a load balancer or a container
  // healthcheck can act on it without having to parse the body.
  res.status(ok ? 200 : 503).json({
    status: ok ? "ok" : "degraded",
    uptimeSeconds: Math.round(process.uptime()),
    checks: { database, docker },
  });
}

/** Counters and gauges. Behind auth: they describe how busy the deployment is
 *  and what is failing, which is not for anyone who can reach the port. */
export function metricsReport(_req: Request, res: Response): Promise<void> {
  res.json({
    success: true,
    message: "Metrics",
    data: {
      uptimeSeconds: Math.round(process.uptime()),
      memoryBytes: process.memoryUsage().rss,
      counters: snapshot(),
    },
  });

  return Promise.resolve();
}
