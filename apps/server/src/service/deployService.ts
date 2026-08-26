import { randomBytes } from "node:crypto";
import { mkdir, opendir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SUBDOMAIN_PATTERN,
  type Deployment,
  type DeploymentState,
  type DeployTarget,
} from "@replit-clone/shared";
import type { DeploymentStatus } from "../generated/prisma/enums.js";
import { DEPLOYMENTS_ROOT, deployOrigin, deploymentsEnabled, env } from "../config/env.js";
import { ensureContainer } from "../containers/containerManager.js";
import { execCapture } from "../containers/execCapture.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import { getTemplate, type StaticBuild } from "../templates/registry.js";
import { assertValidProjectId, projectRoot } from "../utils/projectPaths.js";
import { BadRequestError, ConflictError, NotFoundError } from "../utils/errors.js";

/** Building a project and publishing the result to a public origin.
 *
 *  Everything else in this codebase serves a project to somebody who already
 *  has a session, through a container that is running right now. A deployment
 *  is neither: it is a directory of plain files, copied OUT of the project tree
 *  once, served with no authentication and no container behind it. Two
 *  consequences run through the whole file --
 *
 *  1. What is copied is served to the entire internet, so the copy is the
 *     security boundary. It refuses symlinks, refuses anything that is not a
 *     regular file, and confines every destination path under one root.
 *  2. Nothing reclaims the disk afterwards. A published site outlives its
 *     container, its idle timer, and the session that made it, so its size is
 *     capped before a single byte is written rather than after.
 */

const APP_DIR = "/home/sandbox/app";

/** Longest tail of build output kept.
 *
 *  A bundler emits megabytes on a bad day, and this column is read on every
 *  panel open. The tail is the useful half: an error is at the end. */
const MAX_LOG_CHARS = 8_000;

/* ---- what can be deployed ---- */

/** Why a template cannot be published as static files.
 *
 *  Phrased as the fact rather than as a refusal: these projects are not broken,
 *  they are a different shape, and static hosting is simply not the thing they
 *  need.
 */
const NOT_STATIC =
  "This project serves requests from a running process, so there is nothing " +
  "to publish as static files. Static deployment covers the frontend " +
  "templates — Vite, Next with `output: 'export'`, and static HTML.";

export function deployTarget(templateId: string): DeployTarget {
  const build: StaticBuild | undefined = getTemplate(templateId).staticBuild;

  if (!build) {
    return { deployable: false, reason: NOT_STATIC, buildCommand: "", outputDir: "" };
  }

  return {
    deployable: true,
    buildCommand: build.command,
    outputDir: build.outputDir,
  };
}

/* ---- the address ---- */

/** Halves of a generated name.
 *
 *  Generated and never chosen. A user-supplied subdomain is a namespace to
 *  fight over, and — because this origin is public and unauthenticated — a
 *  ready-made phishing surface: "stripe-login.<host>" is a convincing address
 *  to hand somebody. Four random hex characters on the end make collisions
 *  rare enough that the retry below almost never runs, while keeping the label
 *  short enough to say out loud.
 */
const ADJECTIVES = [
  "amber", "brisk", "calm", "dawn", "eager", "fern", "glad", "hazel",
  "ivory", "jade", "keen", "lucid", "mellow", "noble", "opal", "plum",
  "quiet", "rapid", "sage", "tidal", "umber", "vivid", "warm", "zesty",
];

const NOUNS = [
  "arbor", "brook", "cedar", "delta", "ember", "fjord", "grove", "harbor",
  "isle", "jetty", "knoll", "lagoon", "meadow", "north", "oasis", "prairie",
  "quarry", "ridge", "summit", "thicket", "upland", "vale", "willow", "zenith",
];

function pick(words: string[]): string {
  // `randomBytes` rather than Math.random: the label is the entire address of a
  // public site, so it should not be predictable from another one.
  const index = randomBytes(2).readUInt16BE(0) % words.length;
  return words[index] ?? words[0] ?? "site";
}

export function generateSubdomain(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${randomBytes(2).toString("hex")}`;
}

/** The public URL of a subdomain, built by prefixing the configured origin's
 *  host with the label. Never string-concatenated onto the origin: a URL is
 *  parsed and rebuilt so a port and a scheme survive it correctly. */
export function siteUrl(subdomain: string): string {
  const url = new URL(deployOrigin.toString());
  url.hostname = `${subdomain}.${deployOrigin.hostname}`;
  return url.origin;
}

/** The directory a subdomain's files live in.
 *
 *  The pattern check is not a formality. This value becomes a path segment, and
 *  it arrives from a Host header on the public listener — so a subdomain of
 *  ".." would otherwise address the parent of every site at once.
 */
export function siteDirectory(subdomain: string): string {
  if (!SUBDOMAIN_PATTERN.test(subdomain)) {
    throw new BadRequestError("Not a site name", "BAD_SUBDOMAIN");
  }
  return path.join(DEPLOYMENTS_ROOT, subdomain);
}

/* ---- reading the current state ---- */

const STATUS_OUT = {
  BUILDING: "building",
  LIVE: "live",
  FAILED: "failed",
} as const satisfies Record<DeploymentStatus, Deployment["status"]>;

interface DeploymentRow {
  subdomain: string;
  status: DeploymentStatus;
  buildCommand: string;
  outputDir: string;
  sizeBytes: number;
  log: string;
  error: string | null;
  deployedAt: Date | null;
}

function toDeployment(row: DeploymentRow): Deployment {
  return {
    status: STATUS_OUT[row.status],
    subdomain: row.subdomain,
    // Only once something has actually gone live. A row exists from the moment
    // the first build starts — so that the subdomain is reserved before it is
    // published to — and handing out its URL before then would be a link to a
    // 404.
    url: row.deployedAt ? siteUrl(row.subdomain) : null,
    buildCommand: row.buildCommand,
    outputDir: row.outputDir,
    sizeBytes: row.sizeBytes,
    log: row.log,
    error: row.error,
    deployedAt: row.deployedAt?.toISOString() ?? null,
  };
}

export async function deploymentState(
  projectId: string,
): Promise<DeploymentState> {
  const id = assertValidProjectId(projectId);

  const project = await prisma.project.findUnique({
    where: { id },
    include: { deployment: true },
  });
  if (!project) throw new NotFoundError("Project not found");

  const target = deploymentsEnabled
    ? deployTarget(project.template)
    : {
        deployable: false,
        reason: "Deployments are turned off on this server.",
        buildCommand: "",
        outputDir: "",
      };

  return {
    target,
    deployment: project.deployment ? toDeployment(project.deployment) : null,
  };
}

/* ---- publishing ---- */

/** Projects with a build in flight.
 *
 *  Two concurrent deploys of one project would race over the same staging
 *  directory and the same row. In-process only, which is the right scope while
 *  a deployment is built by the process that serves the request; a multi-node
 *  deployment would need this in the database, and that is worth saying out
 *  loud rather than discovering.
 */
const building = new Set<string>();

/** Keeps the last `MAX_LOG_CHARS` characters, since a failure is at the end. */
export function tailLog(stdout: string, stderr: string): string {
  const combined = [stdout, stderr]
    .filter((part) => part.trim())
    .join("\n")
    .trim();

  return combined.length <= MAX_LOG_CHARS
    ? combined
    : `… ${combined.slice(-MAX_LOG_CHARS)}`;
}

/** Environment the build runs under, on top of the container's own.
 *
 *  Both entries correct something the container is deliberately configured for
 *  and a deployment is not:
 *
 *  - PREVIEW_BASE is what makes a dev server serve under /preview/<id>/. Vite
 *    bakes it into every asset URL at BUILD time, so a build that inherited it
 *    would produce a site whose scripts all point at a path that does not exist
 *    on the deploy origin. "/" is the root the site is actually served from.
 *  - STATIC_EXPORT tells the Next templates to emit plain files instead of the
 *    server bundle `next start` would need. It is off during development on
 *    purpose; a deployment is the one time it must be on.
 */
const BUILD_ENV: Record<string, string> = {
  PREVIEW_BASE: "/",
  STATIC_EXPORT: "1",
  // Every JS toolchain reads this to mean "nobody is watching": no progress
  // spinners to buffer, no prompts to hang on.
  CI: "1",
  NODE_ENV: "production",
};

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new BadRequestError(label, "DEPLOY_TIMEOUT"));
    }, ms);
    timer.unref?.();

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Runs the template's build inside the project's container.
 *
 *  The command is the template registry's own constant, never anything a
 *  request carried, which is why passing it to `sh -c` is safe here in a way it
 *  would not be one layer up.
 */
async function runBuild(
  projectId: string,
  build: StaticBuild,
): Promise<{ log: string; failed: string | null }> {
  if (!build.command) return { log: "", failed: null };

  const container = await ensureContainer(projectId);
  const timeoutMs = env.DEPLOY_BUILD_TIMEOUT_MINUTES * 60 * 1000;

  const { stdout, stderr, exitCode } = await withTimeout(
    execCapture(container, ["sh", "-c", build.command], {
      workingDir: APP_DIR,
      env: BUILD_ENV,
    }),
    timeoutMs,
    `The build did not finish within ${String(env.DEPLOY_BUILD_TIMEOUT_MINUTES)} minutes.`,
  );

  const log = tailLog(stdout, stderr);
  if (exitCode === 0) return { log, failed: null };

  const lastLine =
    log.split("\n").filter(Boolean).slice(-1)[0] ?? "the build command failed";
  return { log, failed: lastLine };
}

/* ---- copying the output out ---- */

export interface CopyResult {
  bytes: number;
  files: number;
}

/** Copies a build output into the published tree, one regular file at a time.
 *
 *  Deliberately not `fs.cp`. Three things have to hold here that a bulk copy
 *  does not give:
 *
 *  - **No symlinks, ever.** A build output is produced by code the platform
 *    treats as untrusted, and a symlink to /etc/passwd copied verbatim into a
 *    directory served publicly and unauthenticated is a file disclosure with no
 *    further steps required. Links are skipped rather than followed, because
 *    following one is the same disclosure with an extra hop.
 *  - **A byte budget checked as it goes.** A published site outlives everything
 *    that would otherwise reclaim its disk, so the cap has to stop the copy,
 *    not report on it afterwards.
 *  - **Every destination confined.** The name of an entry comes from the build,
 *    so each joined path is checked against the root it must stay under.
 */
export async function copyTree(
  from: string,
  to: string,
  budgetBytes: number,
): Promise<CopyResult> {
  let bytes = 0;
  let files = 0;

  async function walk(sourceDir: string, targetDir: string): Promise<void> {
    await mkdir(targetDir, { recursive: true });
    const dir = await opendir(sourceDir);

    for await (const entry of dir) {
      // `opendir` reports the link itself rather than its target, so this is
      // the check that actually stops one being published.
      if (entry.isSymbolicLink()) continue;

      const source = path.join(sourceDir, entry.name);
      const target = path.join(targetDir, entry.name);

      // An entry named ".." or with a separator in it would land outside.
      if (target !== to && !target.startsWith(to + path.sep)) continue;

      if (entry.isDirectory()) {
        await walk(source, target);
        continue;
      }

      // Sockets, FIFOs and device nodes are not servable and not worth
      // copying; a static host has no answer for any of them.
      if (!entry.isFile()) continue;

      const contents = await readFile(source);
      bytes += contents.byteLength;
      if (bytes > budgetBytes) {
        throw new BadRequestError(
          `The build output is larger than the ${String(env.DEPLOY_MAX_MB)} MB ` +
            "limit for one site.",
          "DEPLOY_TOO_LARGE",
        );
      }

      await writeFile(target, contents);
      files += 1;
    }
  }

  await walk(from, to);
  return { bytes, files };
}

/** Where the build output is on the HOST.
 *
 *  Resolved and confined rather than joined: `outputDir` is a template constant
 *  today, but this is the path that decides what gets published, and it should
 *  not become a traversal the day somebody makes it configurable.
 */
function outputPath(projectId: string, outputDir: string): string {
  const root = projectRoot(projectId);
  const absolute = path.resolve(root, outputDir);

  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new BadRequestError(
      "The build output directory is outside the project",
      "PATH_TRAVERSAL",
    );
  }

  return absolute;
}

/** Builds a project and publishes the result. */
export async function publish(rawProjectId: string): Promise<Deployment> {
  const projectId = assertValidProjectId(rawProjectId);

  if (!deploymentsEnabled) {
    throw new BadRequestError(
      "Deployments are turned off on this server.",
      "DEPLOYMENTS_DISABLED",
    );
  }

  if (building.has(projectId)) {
    throw new ConflictError("A deploy is already running", "DEPLOY_IN_FLIGHT");
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { deployment: true },
  });
  if (!project) throw new NotFoundError("Project not found");

  const target = deployTarget(project.template);
  if (!target.deployable) {
    throw new BadRequestError(target.reason ?? NOT_STATIC, "NOT_DEPLOYABLE");
  }

  const build: StaticBuild = {
    command: target.buildCommand,
    outputDir: target.outputDir,
  };

  building.add(projectId);
  try {
    // The row first, so the subdomain is reserved before anything is built for
    // it — and so a build that fails still has somewhere to record why.
    const row = await reserve(projectId, project.deployment?.subdomain, build);

    try {
      const published = await buildAndCopy(projectId, row.subdomain, build);
      increment("deploys_succeeded");

      return toDeployment(
        await prisma.deployment.update({
          where: { projectId },
          data: {
            status: "LIVE",
            sizeBytes: published.bytes,
            log: published.log,
            error: null,
            deployedAt: new Date(),
          },
        }),
      );
    } catch (error) {
      increment("deploys_failed");
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn("deploy failed", { projectId, reason });

      // Recorded rather than only thrown: the panel reads this row, and a
      // failure the user cannot see afterwards is a failure they cannot fix.
      await prisma.deployment.update({
        where: { projectId },
        data: {
          status: "FAILED",
          error: reason,
          log: error instanceof BuildFailure ? error.log : undefined,
        },
      });

      throw error;
    }
  } finally {
    building.delete(projectId);
  }
}

/** Carries the build's own output alongside the failure, so a non-zero exit
 *  reaches the panel with the compiler's reason attached. */
class BuildFailure extends BadRequestError {
  constructor(
    message: string,
    readonly log: string,
  ) {
    super(message, "BUILD_FAILED");
  }
}

/** Creates or re-arms the row, keeping an existing subdomain.
 *
 *  Re-deploying must not move the address: a link already handed out is the
 *  whole point of having published one.
 */
async function reserve(
  projectId: string,
  existing: string | undefined,
  build: StaticBuild,
): Promise<{ subdomain: string }> {
  if (existing) {
    await prisma.deployment.update({
      where: { projectId },
      data: {
        status: "BUILDING",
        error: null,
        buildCommand: build.command,
        outputDir: build.outputDir,
      },
    });
    return { subdomain: existing };
  }

  // Retried on the unique constraint rather than checked first: a check is a
  // race, and the constraint is the thing that actually decides.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const subdomain = generateSubdomain();
    try {
      await prisma.deployment.create({
        data: {
          projectId,
          subdomain,
          status: "BUILDING",
          buildCommand: build.command,
          outputDir: build.outputDir,
        },
      });
      return { subdomain };
    } catch {
      // Only a collision is plausible here, and the next name will not
      // collide. Anything else fails again on the last attempt below.
      continue;
    }
  }

  throw new ConflictError("Could not allocate a site name", "SUBDOMAIN_TAKEN");
}

/** Runs the build, checks what it produced, and swaps it into place. */
async function buildAndCopy(
  projectId: string,
  subdomain: string,
  build: StaticBuild,
): Promise<{ bytes: number; log: string }> {
  const { log, failed } = await runBuild(projectId, build);
  if (failed) throw new BuildFailure(failed, log);

  const source = outputPath(projectId, build.outputDir);

  const stats = await stat(source).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new BuildFailure(
      `The build finished but produced no "${build.outputDir}" directory. ` +
        (build.outputDir === "out"
          ? "A Next.js project needs `output: 'export'` in next.config for a " +
            "static deployment."
          : "Check that the build command writes there."),
      log,
    );
  }

  // An index at the root is what makes the address land somewhere. Without it
  // a visitor gets a 404 on the one URL they were given, which is a worse
  // outcome than being told now.
  const index = await stat(path.join(source, "index.html")).catch(() => null);
  if (!index?.isFile()) {
    throw new BuildFailure(
      `"${build.outputDir}" has no index.html, so the site would have no ` +
        "home page.",
      log,
    );
  }

  const live = siteDirectory(subdomain);
  // A sibling, so the swap below is a rename within one filesystem. Prefixed
  // with a character the subdomain pattern forbids, so a staging directory can
  // never be addressed as a site.
  const staging = path.join(DEPLOYMENTS_ROOT, `.staging-${subdomain}`);

  await rm(staging, { recursive: true, force: true });
  await mkdir(DEPLOYMENTS_ROOT, { recursive: true });

  try {
    const { bytes } = await copyTree(
      source,
      staging,
      env.DEPLOY_MAX_MB * 1024 * 1024,
    );

    // The swap. Removing the old tree first leaves a window where the site
    // 404s, which is the cost of not having two names to alternate between —
    // brief, and far better than serving half of one build and half of another.
    await rm(live, { recursive: true, force: true });
    await rename(staging, live);

    return { bytes, log };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ---- taking a site down ---- */

/** Removes the published files and the row.
 *
 *  Idempotent: unpublishing something already unpublished is what a user
 *  clicking twice means, not an error.
 */
export async function unpublish(rawProjectId: string): Promise<void> {
  const projectId = assertValidProjectId(rawProjectId);

  const row = await prisma.deployment.findUnique({ where: { projectId } });
  if (!row) return;

  await rm(siteDirectory(row.subdomain), { recursive: true, force: true });
  await prisma.deployment.delete({ where: { projectId } });
  increment("deploys_removed");
}

/** Resolves a public request's Host header to a site directory.
 *
 *  Returns undefined for anything that is not a live deployment, which the
 *  listener answers with a 404 — never with a reason. This origin is
 *  unauthenticated, so distinguishing "no such site" from "that site is not
 *  live yet" would let anyone enumerate what exists.
 */
export async function resolveSite(
  hostname: string,
): Promise<{ subdomain: string; root: string } | undefined> {
  const subdomain = subdomainFromHost(hostname);
  if (!subdomain) return undefined;

  const row = await prisma.deployment.findUnique({ where: { subdomain } });
  if (!row || row.deployedAt === null) return undefined;

  return { subdomain, root: siteDirectory(subdomain) };
}

/** The label in front of the configured deploy host, or undefined.
 *
 *  Exported because the parsing is the part worth pinning: a Host header is
 *  attacker-controlled, carries a port, varies in case, and may be an address
 *  rather than a name.
 */
export function subdomainFromHost(rawHost: string): string | undefined {
  // Strip the port. An IPv6 literal is bracketed and can never carry a
  // subdomain, so it is rejected rather than parsed.
  const host = rawHost.toLowerCase().trim();
  if (host.startsWith("[")) return undefined;

  const hostname = host.split(":")[0] ?? "";
  const suffix = `.${deployOrigin.hostname.toLowerCase()}`;

  if (!hostname.endsWith(suffix)) return undefined;

  const label = hostname.slice(0, -suffix.length);
  // Exactly one label: `a.b.<host>` is not a site here, and treating it as one
  // would make every site's address ambiguous.
  return SUBDOMAIN_PATTERN.test(label) ? label : undefined;
}
