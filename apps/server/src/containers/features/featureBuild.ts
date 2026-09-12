import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Dockerode from "dockerode";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { increment } from "../../lib/metrics.js";
import { FeatureError, parseFeatureRef, featureRegistryAllowed } from "./featureRef.js";
import { featureEnv, requestedOptions } from "./featureOptions.js";
import { orderFeatures } from "./featureOrder.js";
import { fetchFeature, type FetchedFeature } from "./featureRegistry.js";

/** Installing Dev Container Features into an image the workspace then runs.
 *  plan.md §11.10.
 *
 *  **The decision this row was blocked on.** §11.10 said Features are "a
 *  question with three answers, and picking one is what unblocks it": run them
 *  at build time into a derived image, run them as root in a throwaway
 *  container and commit the result, or support only the subset that installs
 *  into the user's home directory. **The second is chosen**, under the standing
 *  instruction to decide rather than ask.
 *
 *  **Why the second and not the first.** Both produce a derived image. The
 *  difference is what the input is: option one means this platform builds from
 *  a Dockerfile, and `build` and `dockerFile` are refused *today* precisely
 *  because a Dockerfile is arbitrary code from a repository this platform did
 *  not write. Option two's input is a Feature artifact from a registry an
 *  operator allowlisted, run against a base image this repository ships. That
 *  is a strictly smaller thing to have said yes to, and it does not reopen the
 *  refusal §11.2 wants kept.
 *
 *  **Why not the third.** It would refuse most real Features confusingly rather
 *  than clearly — §11.10's own objection to it, and it is right.
 *
 *  **What still must not become true, and does not.** The WORKSPACE never runs
 *  as root and never gains a capability: `privileged` and `capAdd` stay refused
 *  however personal this gets, because a container that can do anything to the
 *  host can destroy the tree it is mounted on. Root exists here only inside a
 *  build container that has **no bind mount of the user's tree**, no network
 *  beyond what the base image needs, and a lifetime of one install. The thing
 *  §11.2 refuses is a workspace with power over the host; this is a build step
 *  with power over its own filesystem, which is what every image build is.
 *
 *  **And it is off by default.** `DEVCONTAINER_FEATURES` gates the whole path,
 *  and `DEVCONTAINER_FEATURE_REGISTRIES` says whose code may be run. An
 *  operator who did not ask to execute third-party install scripts on their
 *  host should not begin doing so because they upgraded.
 */

/** Long enough for `apt-get install` on a slow mirror, short enough that a
 *  hung build does not hold a project closed forever. Nothing is waiting on
 *  this except the first open of the project, which fails open. */
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

/** Capabilities a package install genuinely needs, and nothing more.
 *
 *  Root in the build container, yes — but not root with the whole capability
 *  set. `apt-get` needs to own files and to drop to `_apt`; it does not need
 *  `SYS_ADMIN`, `NET_ADMIN` or `SYS_PTRACE`, and a Feature's install script is
 *  third-party code that gets exactly what the job requires.
 */
const BUILD_CAPS = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "SETUID", "SETGID"];

const IMAGE_PREFIX = "rc-features";

/** The image tag a set of features against a base produces.
 *
 *  Keyed on the base image and on every feature's resolved DIGEST plus its
 *  options — not on the tag it was written as. A `:1` that has moved must
 *  produce a different image, or "rebuild" would hand back yesterday's
 *  software; and two projects asking for the same thing must share one, or
 *  every project pays the install again.
 */
export function derivedImageTag(
  baseImage: string,
  features: readonly { digest: string; env: Record<string, string> }[],
): string {
  const hash = createHash("sha256");
  hash.update(baseImage);
  for (const feature of features) {
    hash.update("\0");
    hash.update(feature.digest);
    // Options change what an install produces, so they change the identity of
    // what comes out.
    for (const [key, value] of Object.entries(feature.env).sort()) {
      hash.update(`\0${key}=${value}`);
    }
  }
  return `${IMAGE_PREFIX}:${hash.digest("hex").slice(0, 32)}`;
}

export interface PreparedFeature {
  id: string;
  digest: string;
  directory: string;
  env: Record<string, string>;
  containerEnv: Record<string, string>;
}

/** Validates, fetches and orders what the file asked for.
 *
 *  Fetching before building anything, because a refusal has to reach the user
 *  as "this feature is not permitted" rather than as a build that fails halfway
 *  with a container already made.
 */
export async function prepareFeatures(
  requested: Record<string, unknown>,
  into: string,
): Promise<PreparedFeature[]> {
  const entries = Object.entries(requested);
  if (entries.length === 0) return [];

  if (entries.length > env.DEVCONTAINER_FEATURE_LIMIT) {
    throw new FeatureError(
      `At most ${String(env.DEVCONTAINER_FEATURE_LIMIT)} features`,
    );
  }

  const fetched: (FetchedFeature & { requested: Record<string, unknown> })[] = [];

  for (const [id, options] of entries) {
    const ref = parseFeatureRef(id);

    if (!featureRegistryAllowed(ref, env.DEVCONTAINER_FEATURE_REGISTRIES)) {
      throw new FeatureError(
        `${ref.registry} is not a registry this deployment installs features from`,
      );
    }

    const feature = await fetchFeature(ref, into);
    fetched.push({ ...feature, requested: requestedOptions(options, id) });
  }

  // `installsAfter`, after fetching, because it is declared in the metadata we
  // just downloaded rather than in the project's file.
  const ordered = orderFeatures(
    fetched.map((feature) => ({
      id: feature.ref.id,
      installsAfter: feature.metadata.installsAfter,
      feature,
    })),
  );

  return ordered.map(({ feature }) => ({
    id: feature.ref.id,
    digest: feature.digest,
    directory: feature.directory,
    env: featureEnv(feature.metadata, feature.requested),
    containerEnv: feature.metadata.containerEnv ?? {},
  }));
}

/** The script that runs one Feature's installer.
 *
 *  `set -e`, and `cd` into the feature's own directory first — the spec says an
 *  install script may assume its own folder is the working directory, and most
 *  of them do without saying so.
 */
export function installScript(features: readonly PreparedFeature[]): string {
  const lines = ["set -e", "export DEBIAN_FRONTEND=noninteractive"];

  for (const [index, feature] of features.entries()) {
    const dir = `/tmp/rc-features/${String(index)}`;
    lines.push(`cd ${dir}`);
    // Exported one per line with the value single-quoted. `featureEnv` has
    // already refused newlines and null bytes; the quoting is what makes a
    // value with a space in it one value.
    for (const [key, value] of Object.entries(feature.env)) {
      lines.push(`export ${key}='${value.replace(/'/g, "'\\''")}'`);
    }
    lines.push("chmod +x ./install.sh");
    lines.push("./install.sh");
  }

  return lines.join("\n");
}

/** Whether an image is already here, so a second project asking for the same
 *  features does not build them again. */
async function imageExists(docker: Dockerode, tag: string): Promise<boolean> {
  try {
    await docker.getImage(tag).inspect();
    return true;
  } catch {
    return false;
  }
}

/** Builds the derived image, or returns the base unchanged.
 *
 *  Returns the image the workspace should run. Never throws for a reason the
 *  user can fix in their file — those are `FeatureError` and are reported as a
 *  refusal — and never throws for a reason they cannot: a build that fails
 *  leaves the project running the base image with the failure in
 *  `DevcontainerStatus`, because being locked out of a project by a file you
 *  are trying to fix is the worst failure available here.
 */
export async function buildWithFeatures(options: {
  docker: Dockerode;
  baseImage: string;
  features: Record<string, unknown>;
  projectId: string;
}): Promise<{ image: string; containerEnv: Record<string, string> }> {
  const { docker, baseImage, features, projectId } = options;

  if (!env.DEVCONTAINER_FEATURES) return { image: baseImage, containerEnv: {} };
  if (Object.keys(features).length === 0) return { image: baseImage, containerEnv: {} };

  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "rc-features-"));

  try {
    const prepared = await prepareFeatures(features, workspace);
    if (prepared.length === 0) return { image: baseImage, containerEnv: {} };

    const containerEnv = Object.assign(
      {},
      ...prepared.map((feature) => feature.containerEnv),
    ) as Record<string, string>;

    const tag = derivedImageTag(baseImage, prepared);
    if (await imageExists(docker, tag)) {
      increment("feature_builds_reused");
      return { image: tag, containerEnv };
    }

    await runBuild(docker, baseImage, prepared, tag, projectId);
    increment("feature_builds_completed");
    return { image: tag, containerEnv };
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

async function runBuild(
  docker: Dockerode,
  baseImage: string,
  features: readonly PreparedFeature[],
  tag: string,
  projectId: string,
): Promise<void> {
  const container = await docker.createContainer({
    Image: baseImage,
    // Root, and only here. The workspace container this produces still runs as
    // the uid that owns the bind mount, with CapDrop ALL.
    User: "0:0",
    Cmd: ["sleep", "infinity"],
    WorkingDir: "/tmp",
    HostConfig: {
      // No bind mount of the user's tree. Whatever this script does, it cannot
      // touch the project -- which is the specific harm §11.2 refuses
      // `privileged` to prevent.
      Binds: [],
      CapDrop: ["ALL"],
      CapAdd: BUILD_CAPS,
      // Not `no-new-privileges`: an install script legitimately drops to `_apt`
      // and back. The capability set above is what bounds it instead.
      PidsLimit: 512,
      Memory: env.CONTAINER_MEMORY_MB * 1024 * 1024,
      RestartPolicy: { Name: "no" },
    },
  });

  try {
    await container.start();

    // The feature folders, copied in as a tar. `putArchive` rather than a bind
    // mount, so nothing on the host is reachable from inside the build.
    await putFeatures(container, features);

    const script = installScript(features);
    const exec = await container.exec({
      Cmd: ["/bin/sh", "-c", script],
      AttachStdout: true,
      AttachStderr: true,
      User: "0:0",
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    const output = await drain(stream, BUILD_TIMEOUT_MS);
    const result = await exec.inspect();

    if (result.ExitCode !== 0) {
      increment("feature_builds_failed");
      throw new FeatureError(
        `A feature's install script failed: ${lastLine(output) || `exit ${String(result.ExitCode ?? -1)}`}`,
      );
    }

    // Committed with the features' own containerEnv baked in, so a language
    // this installed is on the PATH of every shell the workspace opens rather
    // than only of the one that installed it.
    await container.commit({
      repo: tag.split(":")[0],
      tag: tag.split(":")[1],
      // The workspace's own Cmd and User are set when IT is created; nothing
      // about this build container should survive into the image's config
      // except its filesystem.
      changes: [`ENV ${featureImageEnv(features)}`].filter(
        () => featureImageEnv(features) !== "",
      ),
    });

    logger.info("built an image with dev container features", {
      projectId,
      tag,
      features: features.map((feature) => feature.id),
    });
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

/** The features' `containerEnv`, as one `ENV` change for `commit`. */
function featureImageEnv(features: readonly PreparedFeature[]): string {
  const merged = Object.assign({}, ...features.map((f) => f.containerEnv)) as Record<
    string,
    string
  >;
  return Object.entries(merged)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function lastLine(output: string): string {
  const lines = output.trim().split("\n");
  return lines[lines.length - 1]?.trim() ?? "";
}

/** Reads an exec's output to the end, or gives up.
 *
 *  Drained rather than ignored: an exec whose output nobody reads blocks once
 *  the buffer fills, and an install script is the most talkative thing this
 *  server runs.
 */
function drain(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    /** Only the tail is kept. A build log can be megabytes and the only part
     *  anybody reads is why it stopped. */
    const cap = 8 * 1024;

    const timer = setTimeout(() => {
      resolve(text);
    }, timeoutMs);
    timer.unref?.();

    stream.on("data", (chunk: Buffer) => {
      text = (text + chunk.toString("utf8")).slice(-cap);
    });
    const finish = (): void => {
      clearTimeout(timer);
      resolve(text);
    };
    stream.on("end", finish);
    stream.on("error", finish);
  });
}

/** Copies each feature's folder to `/tmp/rc-features/<index>` in the build
 *  container, in the order they will run. */
async function putFeatures(
  container: Dockerode.Container,
  features: readonly PreparedFeature[],
): Promise<void> {
  const archiver = await import("archiver");
  const tar = archiver.default("tar");

  for (const [index, feature] of features.entries()) {
    tar.directory(feature.directory, String(index));
  }
  await tar.finalize();

  await container.putArchive(tar, { path: "/tmp/rc-features" });
}
