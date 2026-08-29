import { request as httpRequest } from "node:http";
import Docker from "dockerode";
import { env, previewTargetMode } from "../config/env.js";
import { SANDBOX_NETWORK } from "./sandboxNetwork.js";
import { proxyEnv } from "./egressGateway.js";
import { userForDirectory } from "../utils/projectPaths.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import { AppError } from "../utils/errors.js";

/** The container behind a service deployment.
 *
 *  A static deployment has nothing running behind it: the files are copied out
 *  and the container that built them is gone. A service deployment is the
 *  opposite and every difference below follows from that one fact.
 *
 *  It is NOT the project's container. Sharing one would mean a published site
 *  goes down when its author closes the tab, comes back up running whatever
 *  they have edited since, and dies on the idle reaper's schedule. A published
 *  address that behaves like that is worse than not having one. So this is a
 *  second container, over a COPY of the tree, with a lifetime tied to the
 *  deployment rather than to anybody's session.
 */

const docker = new Docker();

/** Name prefix, and the reason it is not the project prefix.
 *
 *  Every sweep in `containerManager` -- the idle reaper, the capacity count,
 *  the boot reconciler -- selects containers by the `rc-project-` prefix. A
 *  deployment container must be in none of those: it is not idle when nobody
 *  is looking at it, it must not be reaped, and it must not consume the budget
 *  that exists so a project can always be opened. A prefix of its own is what
 *  keeps it out of all of them without a single flag being threaded through.
 */
export const DEPLOY_CONTAINER_PREFIX = "rc-deploy-";

/** Where the copied tree is mounted. The same path the project's own container
 *  uses, so a relative path baked into a start command means the same thing in
 *  both. */
const MOUNT_POINT = "/home/sandbox/app";

export function deployContainerName(subdomain: string): string {
  return `${DEPLOY_CONTAINER_PREFIX}${subdomain}`;
}

/** Everything needed to run one published service. */
export interface ServiceSpec {
  subdomain: string;
  /** The template's image, the same one the project develops in. */
  image: string;
  /** Install-and-serve. Does not terminate. */
  command: string;
  /** Where the process listens inside the container. */
  port: number;
  /** Host directory holding the copied source tree. */
  root: string;
  /** The project's own environment variables, already in `NAME=value` form. */
  projectEnv: string[];
  /** Every subdomain published by the owner of this one, this one included.
   *
   *  Passed in rather than looked up, so this module stays a Docker module
   *  with no opinion about who owns what. It answers "which of the containers
   *  running right now are on this account's tab", which is the only thing the
   *  per-user half of the budget needs to know. */
  ownedSubdomains: string[];
}

async function existing(subdomain: string) {
  const container = docker.getContainer(deployContainerName(subdomain));
  const details = await container.inspect().catch(() => null);
  return details ? { container, details } : null;
}

/** Creates and starts the container for a published service.
 *
 *  Replaces any existing one outright rather than restarting it, so a redeploy
 *  picks up the current tree, the current image and the current environment.
 *  Restarting would republish the previous build under a name that claims to
 *  be the new one.
 */
export async function startService(spec: ServiceSpec): Promise<void> {
  await assertServiceBudget(spec.subdomain, spec.ownedSubdomains);
  await removeService(spec.subdomain);

  const publishPort = previewTargetMode === "host-loopback";
  const portKey = `${String(spec.port)}/tcp`;

  const container = await docker.createContainer({
    Image: spec.image,
    name: deployContainerName(spec.subdomain),
    User: await userForDirectory(spec.root),
    WorkingDir: MOUNT_POINT,
    Env: [
      "HOST=0.0.0.0",
      // The templates all read PORT and fall back to their own default, so
      // this is belt and braces -- but a user who changed the default in their
      // code and not in the template would otherwise publish a site that
      // listens somewhere nothing is looking.
      `PORT=${String(spec.port)}`,
      // A published app is not a dev server, and several frameworks decide
      // between an optimised build and a debug one on exactly this.
      "NODE_ENV=production",
      ...proxyEnv(),
      // The project's own variables last, so a user's DATABASE_URL wins over
      // anything above it that happens to share a name.
      ...spec.projectEnv,
    ],
    ...(publishPort ? { ExposedPorts: { [portKey]: {} } } : {}),
    // A shell because these commands have `&&` in them and are written to be
    // read by a person rather than assembled from an argv.
    //
    // `-c` and NOT `-lc`. A login shell sources /etc/profile, which REPLACES
    // PATH with the distribution's default and throws away whatever the image
    // set. Node and Python survive that by living in /usr/bin; Go does not,
    // and `go build` failed with "go: not found" until the readiness timeout
    // gave up five minutes later. The login shell bought nothing.
    Cmd: ["sh", "-c", spec.command],
    HostConfig: {
      ...(publishPort
        ? {
            PortBindings: {
              [portKey]: [{ HostIp: "127.0.0.1", HostPort: "0" }],
            },
          }
        : {}),
      // The copied tree, writable: a Node app writes logs and caches into its
      // own directory, and a published app that cannot is a published app that
      // crashes. It is a copy, so nothing it writes reaches the project.
      Binds: [`${spec.root}:${MOUNT_POINT}`],
      Memory: env.DEPLOY_MEMORY_MB * 1024 * 1024,
      MemorySwap: env.DEPLOY_MEMORY_MB * 1024 * 1024,
      NanoCpus: Math.round(env.DEPLOY_CPUS * 1e9),
      PidsLimit: 256,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      NetworkMode: SANDBOX_NETWORK,
      // The one place in this codebase that asks Docker to restart something.
      //
      // Everything else here is interactive: a container that dies while
      // somebody is watching produces a visible failure they can act on. A
      // published service has nobody watching. An unhandled rejection at 3am
      // would otherwise take the address down until its author happened to
      // look, and "it restarts" is most of what always-on means. `on-failure`
      // rather than `always`, so a container we stopped deliberately stays
      // stopped, with a cap so a boot loop is not an infinite one.
      RestartPolicy: { Name: "on-failure", MaximumRetryCount: 10 },
    },
  });

  await container.start();
  increment("deploy_services_started");
  logger.info("service deployment started", {
    subdomain: spec.subdomain,
    image: spec.image,
    port: spec.port,
  });
}

/** Refuses to start one more than the host, or the account, is configured to
 *  carry.
 *
 *  Counted over running containers rather than over rows, because a row for a
 *  service that is not up is not consuming anything. Skips the subdomain being
 *  published, so a redeploy of an already-live service is never refused for
 *  the space it is already occupying.
 *
 *  Two caps, and the second is why this took a second argument. Only the
 *  host-wide count existed, so one account publishing `MAX_DEPLOYED_SERVICES`
 *  apps took every always-on slot on the machine and every other user's
 *  deploys answered "the server is at its limit" — with nothing anyone but an
 *  administrator could do about it. No malice required; ordinary use gets
 *  there. The project-container path solved exactly this with
 *  `assertUserContainerBudget`, and this one never grew the equivalent.
 *
 *  The two refusals are deliberately different. The host being full is a 503:
 *  a condition of the server, temporary, nothing about this request was wrong.
 *  An account being full is a 429 naming the number, because the person
 *  reading it can act on it — unpublish one of their own.
 */
async function assertServiceBudget(
  subdomain: string,
  ownedSubdomains: readonly string[],
): Promise<void> {
  const name = deployContainerName(subdomain);
  const running = await docker.listContainers({
    filters: { name: [DEPLOY_CONTAINER_PREFIX] },
  });

  const others = running.filter(
    (info) => !info.Names.some((each) => each.replace(/^\//, "") === name),
  );

  if (others.length >= env.MAX_DEPLOYED_SERVICES) {
    increment("deploy_services_capacity_rejected");
    throw new AppError(
      503,
      "DEPLOY_CAPACITY",
      `This server keeps ${String(env.MAX_DEPLOYED_SERVICES)} always-on ` +
        "deployments running at once and is at that limit. Unpublish one " +
        "that is no longer needed, and try again.",
    );
  }

  // The subdomain being published is excluded above, so a redeploy is measured
  // against the account's OTHER live services — a redeploy of an app that is
  // already up never costs a slot it is already holding.
  const mine = new Set(ownedSubdomains);
  const theirs = others.filter((info) =>
    info.Names.some((each) =>
      mine.has(each.replace(/^\//, "").slice(DEPLOY_CONTAINER_PREFIX.length)),
    ),
  );

  if (theirs.length >= env.MAX_DEPLOYED_SERVICES_PER_USER) {
    increment("deploy_services_capacity_rejected");
    throw new AppError(
      429,
      "USER_DEPLOY_LIMIT",
      `You already have ${String(theirs.length)} always-on deployments ` +
        "running. Take one offline before publishing another.",
    );
  }
}

/** Stops and removes a service's container, if it has one.
 *
 *  Forced, and never throws: this runs on unpublish and immediately before a
 *  redeploy, and in both cases the outcome that matters is that the name is
 *  free afterwards. A container that was already gone is the desired state
 *  arrived at early.
 */
export async function removeService(subdomain: string): Promise<void> {
  await docker
    .getContainer(deployContainerName(subdomain))
    .remove({ force: true })
    .catch(() => {});
}

/** The address the public origin should proxy a service's requests to.
 *
 *  Undefined when there is nothing running to proxy to, which the listener
 *  answers the same way it answers an unknown subdomain: a 404 with no reason.
 *  This origin is unauthenticated, so "that site exists but has fallen over"
 *  is not something to tell a stranger.
 */
export async function serviceTarget(
  subdomain: string,
  port: number,
): Promise<string | undefined> {
  const found = await existing(subdomain);
  if (!found || found.details.State?.Running !== true) return undefined;

  const portKey = `${String(port)}/tcp`;

  if (previewTargetMode === "host-loopback") {
    const hostPort =
      found.details.NetworkSettings?.Ports?.[portKey]?.[0]?.HostPort;
    return hostPort ? `http://127.0.0.1:${hostPort}` : undefined;
  }

  const address =
    found.details.NetworkSettings?.Networks?.[SANDBOX_NETWORK]?.IPAddress;
  return address ? `http://${address}:${String(port)}` : undefined;
}

/** Waits until the service actually answers an HTTP request.
 *
 *  An HTTP request rather than a TCP connection, and the difference is not
 *  academic -- it is the bug this replaced. In host-loopback mode the port
 *  being dialled belongs to `docker-proxy`, which accepts a connection on a
 *  published port whether or not anything inside the container is listening,
 *  and only fails when it tries to forward. A TCP connect therefore succeeded
 *  the instant the container was scheduled: every publish reported LIVE within
 *  a second, while `npm install` was still running, and every request to the
 *  new address then died with a socket hang up.
 *
 *  ANY status counts as ready, including 404 and 500. What a published app
 *  serves at `/` is its own business -- an API with no index route is a
 *  perfectly good app -- so the question here is only whether something is
 *  answering, not whether it approves of the request.
 *
 *  Resolves false rather than throwing on timeout, so the caller can attach
 *  the container's own logs to the failure, which is the part a user can act
 *  on.
 */
export async function waitForService(
  subdomain: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const target = await serviceTarget(subdomain, port);

    if (target === undefined) {
      // Not running: either not scheduled yet, or already exited. Exited is
      // terminal -- a container that has stopped is not going to start
      // answering, and waiting out the rest of the timeout only delays a
      // failure the logs already explain.
      const found = await existing(subdomain);
      if (found && found.details.State?.Running === false) return false;
    } else if (await answersHttp(target)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return false;
}

/** One HTTP request, with a timeout of its own so a black-holed address cannot
 *  hold the readiness loop open. Any response is a yes; every transport
 *  failure is a no. */
function answersHttp(target: string): Promise<boolean> {
  const url = new URL(target);

  return new Promise((resolve) => {
    const probe = httpRequest(
      {
        host: url.hostname,
        port: Number(url.port),
        path: "/",
        method: "GET",
        // Some frameworks 400 a request with no Host, which would still be an
        // answer -- but there is no reason to make them.
        headers: { host: url.host, "user-agent": "replit-clone-readiness" },
        timeout: 4000,
      },
      (response) => {
        response.resume();
        resolve(true);
      },
    );

    const fail = () => {
      probe.destroy();
      resolve(false);
    };
    probe.on("error", fail);
    probe.on("timeout", fail);
    probe.end();
  });
}

/** The tail of a service's own output.
 *
 *  This is the only window a user has into why a published app is not
 *  answering: there is no terminal attached to it and no editor open on it.
 */
export async function serviceLogs(
  subdomain: string,
  maxChars: number,
): Promise<string> {
  const found = await existing(subdomain);
  if (!found) return "";

  const raw = await found.container
    .logs({ stdout: true, stderr: true, tail: 200 })
    .catch(() => undefined);
  if (!raw) return "";

  const text = Buffer.isBuffer(raw) ? demultiplex(raw) : String(raw);
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

/** Docker's stream format, back into text.
 *
 *  A container without a TTY -- and these have none, since nobody types at a
 *  published app -- has its output framed: eight bytes of header (stream id,
 *  three reserved, then a big-endian length) in front of each chunk. Read as
 *  UTF-8 without unpicking that, a log tail is peppered with control
 *  characters and the occasional truncated line.
 *
 *  Both streams are folded into one string on purpose: the useful reading of a
 *  crash is stdout and stderr in the order they happened, which is exactly
 *  what the frames already give.
 */
function demultiplex(raw: Buffer): string {
  const parts: Buffer[] = [];
  let offset = 0;

  while (offset + 8 <= raw.length) {
    const length = raw.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + length, raw.length);
    parts.push(raw.subarray(start, end));
    offset = end;
  }

  // No frame header where one was expected means this was never a framed
  // stream -- an older daemon, or a TTY container somebody added later. The
  // raw bytes are a better answer than an empty string.
  if (parts.length === 0) return raw.toString("utf8");

  return Buffer.concat(parts).toString("utf8");
}

/** Subdomains with a container currently running. Used by the boot reconciler
 *  to work out which live deployments need starting again. */
export async function runningServices(): Promise<Set<string>> {
  const containers = await docker
    .listContainers({ filters: { name: [DEPLOY_CONTAINER_PREFIX] } })
    .catch(() => []);

  const names = new Set<string>();
  for (const info of containers) {
    for (const raw of info.Names) {
      const name = raw.replace(/^\//, "");
      if (name.startsWith(DEPLOY_CONTAINER_PREFIX)) {
        names.add(name.slice(DEPLOY_CONTAINER_PREFIX.length));
      }
    }
  }
  return names;
}
