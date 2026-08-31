import path from "node:path";
import { rm } from "node:fs/promises";
import type { DeploymentRelease as ApiRelease } from "@replit-clone/shared";
import { RELEASES_KEPT } from "@replit-clone/shared";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import { BadRequestError, NotFoundError } from "../utils/errors.js";
import { DEPLOYMENTS_ROOT } from "../config/env.js";
import { SUBDOMAIN_PATTERN } from "@replit-clone/shared";

/** Published builds, kept so one can be gone back to.
 *
 *  A publish used to overwrite its own predecessor: `Deployment.projectId` is
 *  unique and the static path renamed a staging directory over the live one,
 *  so "put back the one that worked" had nothing to put back.
 *
 *  **The live release is a pointer, not a copy.** Every build keeps its own
 *  directory and `Deployment.liveReleaseId` names the one being served, so a
 *  rollback is a database write: nothing is rebuilt, nothing is copied, and
 *  what comes back is exactly the bytes that were serving before — not a fresh
 *  build of a source tree that has moved on since. Rebuilding would be a
 *  different program with the same name.
 */

/** Where one release's files live.
 *
 *  Under a directory the subdomain pattern forbids, so a release can never be
 *  addressed as a site by a Host header — the same reason the staging
 *  directory is prefixed with a dot.
 */
export function releaseDirectory(subdomain: string, releaseId: string): string {
  if (!SUBDOMAIN_PATTERN.test(subdomain)) {
    throw new BadRequestError("Not a site name", "BAD_SUBDOMAIN");
  }

  // The id is generated here, never supplied by a request — but it becomes a
  // path segment, so it is checked like one anyway.
  if (!/^[a-f0-9-]{36}$/.test(releaseId)) {
    throw new BadRequestError("Not a release", "BAD_RELEASE");
  }

  return path.join(DEPLOYMENTS_ROOT, `.releases-${subdomain}`, releaseId);
}

function toApi(row: {
  id: string;
  kind: string;
  buildCommand: string;
  outputDir: string;
  sizeBytes: number;
  log: string;
  createdAt: Date;
}, liveReleaseId: string | null): ApiRelease {
  return {
    id: row.id,
    kind: row.kind === "SERVICE" ? "service" : "static",
    buildCommand: row.buildCommand,
    outputDir: row.outputDir,
    sizeBytes: row.sizeBytes,
    log: row.log,
    createdAt: row.createdAt.toISOString(),
    live: row.id === liveReleaseId,
  };
}

/** A project's published builds, newest first, with the live one marked. */
export async function listReleases(projectId: string): Promise<ApiRelease[]> {
  const deployment = await prisma.deployment.findUnique({
    where: { projectId },
    select: { id: true, liveReleaseId: true },
  });

  if (!deployment) return [];

  const rows = await prisma.deploymentRelease.findMany({
    where: { deploymentId: deployment.id },
    orderBy: { createdAt: "desc" },
  });

  return rows.map((row) => toApi(row, deployment.liveReleaseId));
}

/** Records a build as a release and makes it the live one. */
export async function recordRelease(input: {
  deploymentId: string;
  subdomain: string;
  kind: "STATIC" | "SERVICE";
  buildCommand: string;
  outputDir: string;
  sizeBytes: number;
  log: string;
}): Promise<string> {
  const release = await prisma.deploymentRelease.create({
    data: {
      deploymentId: input.deploymentId,
      subdomain: input.subdomain,
      kind: input.kind,
      buildCommand: input.buildCommand,
      outputDir: input.outputDir,
      sizeBytes: input.sizeBytes,
      log: input.log,
    },
    select: { id: true },
  });

  return release.id;
}

/** Drops releases past the limit, and their files with them.
 *
 *  The live one is never pruned however old it is. A rollback to a build from
 *  a fortnight ago must not make that build the next thing deleted for being
 *  old — what is being served is by definition not stale.
 */
export async function pruneReleases(
  deploymentId: string,
  liveReleaseId: string | null,
): Promise<void> {
  const rows = await prisma.deploymentRelease.findMany({
    where: { deploymentId },
    orderBy: { createdAt: "desc" },
    select: { id: true, subdomain: true, kind: true },
  });

  const doomed = rows
    .slice(RELEASES_KEPT)
    .filter((row) => row.id !== liveReleaseId);

  if (doomed.length === 0) return;

  for (const row of doomed) {
    if (row.kind !== "STATIC") continue;

    // Files first. A row deleted while its directory survives is disk nothing
    // will ever account for again; a directory deleted while its row survives
    // is a rollback target that would 404, and the row is removed next anyway.
    await rm(releaseDirectory(row.subdomain, row.id), {
      recursive: true,
      force: true,
    }).catch((error: unknown) => {
      logger.error("could not remove an old release's files", error, {
        releaseId: row.id,
      });
    });
  }

  await prisma.deploymentRelease.deleteMany({
    where: { id: { in: doomed.map((row) => row.id) } },
  });
}

/** Removes every release of a deployment, and their files. Used when a whole
 *  site is taken down. */
export async function removeAllReleases(
  deploymentId: string,
  subdomain: string,
): Promise<void> {
  const rows = await prisma.deploymentRelease.findMany({
    where: { deploymentId },
    select: { id: true, kind: true },
  });

  for (const row of rows) {
    if (row.kind !== "STATIC") continue;
    await rm(releaseDirectory(subdomain, row.id), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }

  // The parent, so an unpublished subdomain leaves nothing behind at all.
  await rm(path.join(DEPLOYMENTS_ROOT, `.releases-${subdomain}`), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
}

/** Serves an earlier build again.
 *
 *  A pointer move and a metadata copy, and nothing else: no build runs, and the
 *  files are the ones that build produced. That is the whole point — a
 *  "rollback" that rebuilt from source would publish whatever the tree says
 *  today, which is not what anybody means by going back.
 */
export async function rollbackTo(
  projectId: string,
  releaseId: string,
): Promise<ApiRelease[]> {
  const deployment = await prisma.deployment.findUnique({
    where: { projectId },
    select: { id: true, liveReleaseId: true },
  });

  if (!deployment) {
    throw new NotFoundError("This project has no deployment.", "NOT_DEPLOYED");
  }

  const release = await prisma.deploymentRelease.findFirst({
    where: { id: releaseId, deploymentId: deployment.id },
  });

  // Scoped by deployment in the WHERE clause rather than checked afterwards,
  // so a release id belonging to somebody else's site cannot be rolled back to
  // by naming your own project.
  if (!release) {
    throw new NotFoundError("No such release.", "NO_SUCH_RELEASE");
  }

  if (release.kind !== "STATIC") {
    throw new BadRequestError(
      "Only a static site can be rolled back. A service publishes a running " +
        "container, and what it ran was built from a source tree that has " +
        "since changed — publish again instead.",
      "SERVICE_NOT_ROLLBACKABLE",
    );
  }

  if (deployment.liveReleaseId === releaseId) {
    throw new BadRequestError(
      "That build is already the one being served.",
      "ALREADY_LIVE",
    );
  }

  await prisma.deployment.update({
    where: { id: deployment.id },
    data: {
      liveReleaseId: release.id,
      // The deployment describes what is SERVING, so it takes the release's
      // account of itself back too. Leaving the newer build's command and size
      // on the row would have the panel describe a build nobody is serving.
      kind: release.kind,
      buildCommand: release.buildCommand,
      outputDir: release.outputDir,
      sizeBytes: release.sizeBytes,
      log: release.log,
      error: null,
      status: "LIVE",
      deployedAt: new Date(),
    },
  });

  increment("deploys_rolled_back");
  logger.info("deployment rolled back", { projectId, releaseId });

  return listReleases(projectId);
}
