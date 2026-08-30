import { randomBytes } from "node:crypto";
import { mkdir, opendir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SUBDOMAIN_PATTERN,
  type Deployment,
  type DeploymentKind,
  type DeploymentState,
  type DeployTarget,
} from "@replit-clone/shared";
import type {
  DeploymentKind as DeploymentKindRow,
  DeploymentStatus,
} from "../generated/prisma/enums.js";
import { DEPLOYMENTS_ROOT, deployOrigin, deploymentsEnabled, env } from "../config/env.js";
import {
  pruneReleases,
  recordRelease,
  releaseDirectory,
  removeAllReleases,
} from "./releaseService.js";
import { ensureContainer } from "../containers/containerManager.js";
import { execCapture } from "../containers/execCapture.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import {
  removeService,
  runningServices,
  serviceLogs,
  serviceTarget,
  startService,
  waitForService,
} from "../containers/deployContainer.js";
import { getEnvVars, toDockerEnv } from "./projectEnvService.js";
import { getTemplate, type StaticBuild } from "../templates/registry.js";
import { assertValidProjectId, projectRoot } from "../utils/projectPaths.js";
import { resolveCustomDomain, toCustomDomain } from "./customDomainService.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../utils/errors.js";

/** Building a project and publishing the result to a public origin.
 *
 *  Everything else in this codebase serves a project to somebody who already
 *  has a session, through a container that is running right now. A deployment
 *  is neither, and it comes in two shapes:
 *
 *  - **static** — a directory of plain files, copied OUT of the project tree
 *    once and served with no container behind it at all. Preferred wherever a
 *    template can produce one: nothing to keep running, nothing to crash.
 *  - **service** — for the templates that answer requests from a process and
 *    therefore have no directory to offer. The source is copied out the same
 *    way, and a container of its own runs it for as long as it stays
 *    published, with the public origin proxying to it.
 *
 *  Three consequences run through the whole file --
 *
 *  1. What is copied is served to the entire internet, so the copy is the
 *     security boundary. It refuses symlinks, refuses anything that is not a
 *     regular file, and confines every destination path under one root.
 *  2. Nothing reclaims the disk afterwards. A published site outlives its
 *     container, its idle timer, and the session that made it, so its size is
 *     capped before a single byte is written rather than after.
 *  3. A copy, never the project tree itself. A published address that changed
 *     under its visitors every time its author saved a file would not be a
 *     deployment; it would be the preview with the authentication removed.
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
const NOT_DEPLOYABLE =
  "This template has neither a static build nor a serve command, so there is " +
  "nothing to publish. Every template that ships with this platform has one " +
  "of the two.";

/** How a project would be published, worked out from its template.
 *
 *  Static wins wherever both are declared. It is the cheaper mechanism by a
 *  wide margin -- no container, no memory held while nobody visits, nothing to
 *  fall over unattended -- so a template that can produce files should publish
 *  files. Service exists for the templates that cannot.
 */
export function deployTarget(templateId: string): DeployTarget {
  const template = getTemplate(templateId);
  const build: StaticBuild | undefined = template.staticBuild;

  if (build) {
    return {
      deployable: true,
      kind: "static",
      buildCommand: build.command,
      outputDir: build.outputDir,
      port: null,
    };
  }

  const service = template.serviceDeploy;
  if (service) {
    return {
      deployable: true,
      kind: "service",
      buildCommand: service.command,
      // Nothing is read back: the command does not terminate.
      outputDir: "",
      port: service.port,
    };
  }

  return {
    deployable: false,
    kind: "static",
    reason: NOT_DEPLOYABLE,
    buildCommand: "",
    outputDir: "",
    port: null,
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
  port: number | null;
  kind: DeploymentKindRow;
  sizeBytes: number;
  log: string;
  error: string | null;
  deployedAt: Date | null;
  customDomain: string | null;
  domainToken: string | null;
  domainVerifiedAt: Date | null;
  domainCheckedAt: Date | null;
}

const KIND_OUT = {
  STATIC: "static",
  SERVICE: "service",
} as const satisfies Record<DeploymentKindRow, DeploymentKind>;

const KIND_IN = {
  static: "STATIC",
  service: "SERVICE",
} as const satisfies Record<DeploymentKind, DeploymentKindRow>;

function toDeployment(row: DeploymentRow): Deployment {
  return {
    status: STATUS_OUT[row.status],
    kind: KIND_OUT[row.kind],
    subdomain: row.subdomain,
    // Only once something has actually gone live. A row exists from the moment
    // the first build starts — so that the subdomain is reserved before it is
    // published to — and handing out its URL before then would be a link to a
    // 404.
    url: row.deployedAt ? siteUrl(row.subdomain) : null,
    buildCommand: row.buildCommand,
    outputDir: row.outputDir,
    port: row.port,
    sizeBytes: row.sizeBytes,
    log: row.log,
    error: row.error,
    deployedAt: row.deployedAt?.toISOString() ?? null,
    customDomain: toCustomDomain(row),
  };
}

/** What a published service is actually doing, as opposed to what the row
 *  remembers about the moment it was published.
 *
 *  Two things go stale the instant `publish` returns, and both of them are
 *  read from this one place:
 *
 *  1. **The status.** The row says LIVE from the successful publish onwards
 *     and nothing ever writes to it again. Docker restarts a service that
 *     crashes, ten times, and then leaves it dead -- from which moment the
 *     public address answers 503 and the owner's panel shows a green dot for
 *     as long as they care to look at it. The one person who could fix the app
 *     was the one being told nothing was wrong.
 *  2. **The log.** `deployment.log` is the tail captured during publish. A
 *     service up for a week showed its first thirty seconds, which is the half
 *     of its output least likely to explain anything.
 *
 *  Read-time only, and deliberately not written back. `restoreServices` brings
 *  LIVE rows up after the host restarts, so persisting FAILED here would mean
 *  a crashed app were never resurrected -- the row records what was asked for,
 *  and this records what is true right now.
 *
 *  Never throws. A daemon that cannot be reached is a reason to show the row
 *  as it stands, not a reason for the panel to fail to load.
 */
async function observeService(row: DeploymentRow): Promise<Deployment> {
  const stored = toDeployment(row);

  // Only a running service can disagree with its row. A static deployment has
  // no container, and a row that already says BUILDING or FAILED is not
  // claiming anything that needs checking.
  if (row.kind !== "SERVICE" || row.status !== "LIVE" || row.port === null) {
    return stored;
  }

  try {
    const target = await serviceTarget(row.subdomain, row.port);
    const log = await serviceLogs(row.subdomain, MAX_LOG_CHARS);

    // Empty means there is no container to ask -- keep the publish-time tail,
    // which is the last thing anyone did see, rather than blanking the panel.
    const current = log.trim() ? log : stored.log;

    if (target !== undefined) return { ...stored, log: current };

    return {
      ...stored,
      status: "failed",
      error:
        "This deployment is not answering. Its container has stopped, and " +
        "Docker has given up restarting it. The output below is the last " +
        "thing it printed; deploy again once the cause is fixed.",
      log: current,
    };
  } catch {
    return stored;
  }
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
    : ({
        deployable: false,
        kind: "static",
        reason: "Deployments are turned off on this server.",
        buildCommand: "",
        outputDir: "",
        port: null,
      } satisfies DeployTarget);

  return {
    target,
    deployment: project.deployment
      ? await observeService(project.deployment)
      : null,
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
  skip?: (name: string) => boolean,
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

      // Only a service deployment passes this, to leave installed
      // dependencies and history behind. A static build output has nothing
      // in it that should be skipped -- it is exactly what was asked for.
      if (skip?.(entry.name)) continue;

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

/** Directory names never copied into a service deployment.
 *
 *  Not an optimisation. `node_modules` is reinstalled by the deploy command
 *  anyway and can hold native binaries built for a different libc than the
 *  deployment image; copying it means publishing a tree that may not run, and
 *  spending the byte budget to do it. `.git` carries the project's whole
 *  history including anything ever committed and later removed, into a
 *  directory whose only job is to be readable by a container -- and, if a
 *  template ever gains a static build, by the internet.
 */
const SKIPPED_FROM_SOURCE = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "dist",
  "build",
]);

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

  // `resolveSite` already refuses to serve this, so nothing built here would
  // reach anybody -- which is the mildest of the four surfaces the takedown
  // never reached, and still worth refusing at the door. A build is a
  // container and several minutes, and the deploy panel afterwards would
  // report a live deployment that 404s for every visitor: wrong about the one
  // thing it exists to say.
  if (project.takenDownAt) {
    throw new ForbiddenError(
      "A moderator took this project down after a report. It cannot be " +
        "deployed while that stands.",
      "TAKEN_DOWN",
    );
  }

  const target = deployTarget(project.template);
  if (!target.deployable) {
    throw new BadRequestError(target.reason ?? NOT_DEPLOYABLE, "NOT_DEPLOYABLE");
  }

  const build: StaticBuild = {
    command: target.buildCommand,
    outputDir: target.outputDir,
  };

  building.add(projectId);
  try {
    // The row first, so the subdomain is reserved before anything is built for
    // it — and so a build that fails still has somewhere to record why.
    const row = await reserve(
      projectId,
      project.deployment?.subdomain,
      build,
      target,
    );

    // The release row is created BEFORE the build, because the build writes
    // into a directory named after it. A release whose build then fails is
    // pruned like any other -- and leaving the previous one live meanwhile is
    // the behaviour that was wanted anyway.
    const releaseId = await recordRelease({
      deploymentId: row.id,
      subdomain: row.subdomain,
      kind: target.kind === "service" ? "SERVICE" : "STATIC",
      buildCommand: build.command,
      outputDir: build.outputDir,
      sizeBytes: 0,
      log: "",
    });

    try {
      const published =
        target.kind === "service"
          ? await publishService(projectId, row.subdomain, project.template)
          : await buildAndCopy(projectId, row.subdomain, build, releaseId);
      increment("deploys_succeeded");

      await prisma.deploymentRelease.update({
        where: { id: releaseId },
        data: { sizeBytes: published.bytes, log: published.log },
      });

      const updated = await prisma.deployment.update({
        where: { projectId },
        data: {
          status: "LIVE",
          sizeBytes: published.bytes,
          log: published.log,
          error: null,
          deployedAt: new Date(),
          liveReleaseId: releaseId,
        },
      });

      // After the pointer moves, so the build that just went live is never the
      // one pruned for being surplus.
      await pruneReleases(row.id, releaseId);

      return toDeployment(updated);
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
  target: DeployTarget,
): Promise<{ id: string; subdomain: string }> {
  const shape = { kind: KIND_IN[target.kind], port: target.port };

  if (existing) {
    const row = await prisma.deployment.update({
      where: { projectId },
      data: {
        status: "BUILDING",
        error: null,
        buildCommand: build.command,
        outputDir: build.outputDir,
        // Re-read from the template on every deploy, so a project whose
        // template gained a static build publishes as static from then on
        // rather than staying a service because it once was one.
        ...shape,
      },
    });
    return { id: row.id, subdomain: existing };
  }

  // Retried on the unique constraint rather than checked first: a check is a
  // race, and the constraint is the thing that actually decides.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const subdomain = generateSubdomain();
    try {
      const row = await prisma.deployment.create({
        data: {
          projectId,
          subdomain,
          status: "BUILDING",
          buildCommand: build.command,
          outputDir: build.outputDir,
          ...shape,
        },
      });
      return { id: row.id, subdomain };
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
  releaseId: string,
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

  // A sibling, so the move below is a rename within one filesystem. Prefixed
  // with a character the subdomain pattern forbids, so a staging directory can
  // never be addressed as a site.
  const staging = path.join(DEPLOYMENTS_ROOT, `.staging-${subdomain}`);
  const destination = releaseDirectory(subdomain, releaseId);

  await rm(staging, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });

  try {
    const { bytes } = await copyTree(
      source,
      staging,
      env.DEPLOY_MAX_MB * 1024 * 1024,
    );

    // Into a directory of its own rather than over the live one. The old build
    // is left exactly where it was, which is what makes going back to it a
    // pointer move instead of a rebuild — and it removes the window where the
    // site 404s, because nothing is deleted to make room.
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);

    return { bytes, log };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Copies the source out and runs it in a container of its own.
 *
 *  The static path builds and then reads a directory back. There is nothing to
 *  read back here: the command does not terminate, so "did it work" can only
 *  be answered by asking the running thing. That is what the readiness wait is
 *  -- and why its failure attaches the container's own logs, which are the
 *  only account of what went wrong that the user has any way to see.
 */
/** Every subdomain published by the account that owns this project.
 *
 *  Handed to `startService` so the per-user half of the deployment budget can
 *  be counted without `deployContainer` knowing anything about ownership.
 *  Counted against the OWNER rather than whoever pressed Deploy, matching the
 *  project-container budget: a project shared with several people costs its
 *  owner one slot, not one each.
 */
async function ownedSubdomains(projectId: string): Promise<string[]> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { ownerId: true },
  });
  if (!project) return [];

  const rows = await prisma.deployment.findMany({
    where: { kind: "SERVICE", project: { ownerId: project.ownerId } },
    select: { subdomain: true },
  });
  return rows.map((row) => row.subdomain);
}

async function publishService(
  projectId: string,
  subdomain: string,
  templateId: string,
): Promise<{ bytes: number; log: string }> {
  const template = getTemplate(templateId);
  const service = template.serviceDeploy;
  if (!service) {
    // Unreachable via `publish`, which checked the target first. Stated
    // rather than asserted, because a template edited later should fail here
    // legibly rather than with a property access on undefined.
    throw new BadRequestError(
      "This template has no serve command.",
      "NOT_DEPLOYABLE",
    );
  }

  const live = siteDirectory(subdomain);
  const staging = path.join(DEPLOYMENTS_ROOT, `.staging-${subdomain}`);

  await rm(staging, { recursive: true, force: true });
  await mkdir(DEPLOYMENTS_ROOT, { recursive: true });

  let bytes = 0;
  try {
    ({ bytes } = await copyTree(
      projectRoot(projectId),
      staging,
      env.DEPLOY_MAX_MB * 1024 * 1024,
      (name) => SKIPPED_FROM_SOURCE.has(name),
    ));

    // The container holds the live directory open, so it has to let go before
    // the tree beneath it is replaced. Removing it here rather than inside
    // `startService` also means a redeploy that fails to copy has already
    // taken the previous version down -- which is the honest outcome: what is
    // published should be what was last asked for, not a mix.
    await removeService(subdomain);

    await rm(live, { recursive: true, force: true });
    await rename(staging, live);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }

  await startService({
    subdomain,
    image: template.image,
    command: service.command,
    port: service.port,
    root: live,
    projectEnv: toDockerEnv(await getEnvVars(projectId)),
    ownedSubdomains: await ownedSubdomains(projectId),
  });

  const ready = await waitForService(
    subdomain,
    service.port,
    env.DEPLOY_READY_TIMEOUT_MS,
  );

  const log = await serviceLogs(subdomain, MAX_LOG_CHARS);

  if (!ready) {
    // Left running rather than torn down. The logs above are a snapshot; a
    // user reading "it never answered" is going to want to look again, and a
    // container removed on the way out of this function is one they cannot.
    // The row records FAILED, so nothing is served from it either way.
    throw new BuildFailure(
      `The app did not start listening on port ${String(service.port)} ` +
        `within ${String(Math.round(env.DEPLOY_READY_TIMEOUT_MS / 1000))} ` +
        "seconds. The output below is what it printed.",
      log,
    );
  }

  return { bytes, log };
}

/** Brings published services back up after the host restarts.
 *
 *  Without this, "always-on" lasts until the next deploy of this platform. A
 *  Docker restart policy covers a process that crashes, but not a container
 *  that was removed, a daemon that was restarted with its containers pruned,
 *  or a machine that was rebuilt -- and in all three the row still says LIVE
 *  and the address still resolves. The gap between what the database claims
 *  and what is running is the thing to close on boot.
 *
 *  Deliberately does not wait for readiness. A slow install must not hold the
 *  server's own startup, and a service that never comes up is already visible:
 *  the address answers 503 and says so. Failures are logged per deployment and
 *  never propagate, because one broken published app is not a reason for the
 *  platform not to start.
 */
export async function restoreServices(): Promise<{ restored: number }> {
  if (!deploymentsEnabled) return { restored: 0 };

  const rows = await prisma.deployment.findMany({
    where: { kind: "SERVICE", status: "LIVE" },
    include: { project: { select: { template: true } } },
  });
  if (rows.length === 0) return { restored: 0 };

  const alreadyUp = await runningServices();
  let restored = 0;

  for (const row of rows) {
    if (alreadyUp.has(row.subdomain)) continue;
    if (row.port === null) continue;

    const template = getTemplate(row.project.template);
    if (!template.serviceDeploy) continue;

    try {
      await startService({
        subdomain: row.subdomain,
        image: template.image,
        // The command RECORDED on the row, not the template's current one.
        // Restoring is meant to put back what was published, and a template
        // edited since was never deployed here.
        command: row.buildCommand,
        port: row.port,
        root: siteDirectory(row.subdomain),
        projectEnv: toDockerEnv(await getEnvVars(row.projectId)),
        // Restoring respects the per-user cap too. A cap lowered since these
        // were published means the excess does not come back — which the
        // owner's panel now reports honestly rather than as a green dot, and
        // which the warning below records.
        ownedSubdomains: await ownedSubdomains(row.projectId),
      });
      restored += 1;
    } catch (error) {
      logger.warn("could not restore service deployment", {
        subdomain: row.subdomain,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { restored };
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

  // Before the files, because the container has them mounted. Unconditional
  // rather than only for a SERVICE row: a project that was published as a
  // service and later as static has a container from the earlier shape that
  // nothing else will ever clean up.
  await removeService(row.subdomain);

  await rm(siteDirectory(row.subdomain), { recursive: true, force: true });
  // Every retained build as well as the legacy directory. Missing these would
  // leave a site's whole history on disk with no row referring to it, which is
  // storage nothing would ever account for again.
  await removeAllReleases(row.id, row.subdomain);
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
export interface ResolvedSite {
  subdomain: string;
  /** Where the files are. Meaningful for a static site; for a service it is
   *  the source tree its container has mounted, which is never served from
   *  here. */
  root: string;
  kind: DeploymentKind;
  /** The container port to proxy to, for a service. Null for a static site. */
  port: number | null;
}

export async function resolveSite(
  hostname: string,
): Promise<ResolvedSite | undefined> {
  // The generated subdomain first, because it is the address every deployment
  // has and the one that costs a string comparison rather than a query.
  const subdomain =
    subdomainFromHost(hostname) ??
    (await resolveCustomDomain(hostname))?.subdomain;

  if (!subdomain) return undefined;

  // The takedown is part of the QUERY, like the verified check in
  // `resolveCustomDomain`. `unpublish` is also called when a moderator acts,
  // but that removes files and stops a container, and a public site that stays
  // up whenever a teardown half-failed is not a takedown -- it is a takedown
  // that usually works. This clause is true whether or not anything was
  // cleaned up.
  const row = await prisma.deployment.findFirst({
    where: {
      subdomain,
      deployedAt: { not: null },
      project: { takenDownAt: null },
    },
  });
  if (!row) return undefined;

  return {
    subdomain,
    // The pointer, falling back to the legacy location for a deployment
    // published before releases existed -- those still have their files
    // directly under the subdomain, and they must not start 404ing because a
    // column they predate is null.
    root: row.liveReleaseId
      ? releaseDirectory(subdomain, row.liveReleaseId)
      : siteDirectory(subdomain),
    kind: KIND_OUT[row.kind],
    port: row.port,
  };
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
