import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import fsp from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import extract from "tar-stream";
import { logger } from "../../lib/logger.js";
import { FeatureError, type FeatureRef } from "./featureRef.js";
import type { FeatureMetadata } from "./featureOptions.js";

/** Fetching a Dev Container Feature out of an OCI registry. plan.md §11.10.
 *
 *  A Feature is an OCI artifact: a manifest whose single layer is a `.tgz`
 *  holding `devcontainer-feature.json` and `install.sh`. There is no client
 *  for this in the tree and adding a general-purpose one would be a large
 *  dependency in front of the decision about what code runs in the sandbox, so
 *  this is the three requests the spec actually needs — token, manifest, blob
 *  — and nothing else.
 *
 *  **Everything here treats the registry as hostile**, because it is a host
 *  named in a file this platform did not write:
 *
 *  - The blob is size-capped while streaming, not after. A registry that
 *    answers a 20 KB feature with an endless stream should cost bounded disk,
 *    and `Content-Length` is the registry's claim rather than a fact.
 *  - The digest is verified against what was actually read. A layer that does
 *    not hash to what the manifest said is refused — this is the only thing
 *    standing between "pinned by digest" meaning something and meaning nothing.
 *  - Every path in the tar is resolved and checked to be inside the target.
 *    `../../etc/cron.d/x` in an archive is the oldest trick there is, and this
 *    archive is about to be run as root.
 */

/** A feature is two small files. 32 MB is far above any real one and small
 *  enough that a hostile registry cannot fill the disk. */
const MAX_LAYER_BYTES = 32 * 1024 * 1024;

/** Registries are on the network; a build must not hang on one. */
const REQUEST_TIMEOUT_MS = 30_000;

const MANIFEST_TYPES = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

interface Manifest {
  layers?: { digest?: string; mediaType?: string; size?: number }[];
}

async function request(url: string, headers: Record<string, string>): Promise<Response> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return response;
}

/** Registry auth, as the distribution spec actually does it: ask, be told 401
 *  with a `WWW-Authenticate` naming where to get a token, get one, retry.
 *
 *  Anonymous. A private Feature would need a credential, and a credential for
 *  a registry named in a repository file is a decision this row does not get
 *  to make on its own -- so a private Feature fails, visibly, the same way a
 *  private dotfiles repository does (§11.9). */
async function withToken(
  url: string,
  accept: string,
): Promise<Response> {
  const first = await request(url, { Accept: accept });
  if (first.status !== 401) return first;

  const challenge = first.headers.get("www-authenticate") ?? "";
  const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
  const service = /service="([^"]+)"/.exec(challenge)?.[1];
  const scope = /scope="([^"]+)"/.exec(challenge)?.[1];

  if (realm === undefined) {
    throw new FeatureError("That registry asked for credentials this cannot supply");
  }

  const tokenUrl = new URL(realm);
  if (service !== undefined) tokenUrl.searchParams.set("service", service);
  if (scope !== undefined) tokenUrl.searchParams.set("scope", scope);

  const tokenResponse = await request(tokenUrl.toString(), { Accept: "application/json" });
  if (!tokenResponse.ok) {
    throw new FeatureError("That registry would not issue a token");
  }

  const body = (await tokenResponse.json()) as { token?: string; access_token?: string };
  const token = body.token ?? body.access_token;
  if (token === undefined) {
    throw new FeatureError("That registry's token response made no sense");
  }

  return request(url, { Accept: accept, Authorization: `Bearer ${token}` });
}

/** The digest of the one layer holding the feature. */
export async function resolveLayer(ref: FeatureRef): Promise<string> {
  const reference = ref.digest ?? ref.tag ?? "latest";
  const url = `https://${ref.registry}/v2/${ref.repository}/manifests/${reference}`;

  const response = await withToken(url, MANIFEST_TYPES);
  if (!response.ok) {
    throw new FeatureError(
      `Could not read ${ref.id} from its registry (${String(response.status)})`,
    );
  }

  const manifest = (await response.json()) as Manifest;
  const layer = manifest.layers?.[0];

  if (typeof layer?.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(layer.digest)) {
    throw new FeatureError(`${ref.id} does not look like a feature`);
  }
  if (typeof layer.size === "number" && layer.size > MAX_LAYER_BYTES) {
    throw new FeatureError(`${ref.id} is too large to be a feature`);
  }

  return layer.digest;
}

/** Reads the blob, checking its length as it goes and its digest at the end. */
async function readLayer(ref: FeatureRef, digest: string): Promise<Buffer> {
  const url = `https://${ref.registry}/v2/${ref.repository}/blobs/${digest}`;
  const response = await withToken(url, "application/octet-stream");

  if (!response.ok || !response.body) {
    throw new FeatureError(
      `Could not download ${ref.id} (${String(response.status)})`,
    );
  }

  const chunks: Buffer[] = [];
  let total = 0;

  // Capped WHILE streaming. `Content-Length` is the registry's claim, and a
  // registry that answers a 20 KB feature with an endless stream must cost
  // bounded memory rather than the machine.
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > MAX_LAYER_BYTES) {
      throw new FeatureError(`${ref.id} is larger than a feature should ever be`);
    }
    chunks.push(Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks);
  const actual = `sha256:${createHash("sha256").update(body).digest("hex")}`;

  // The only thing that makes "pinned by digest" mean anything.
  if (actual !== digest) {
    throw new FeatureError(`${ref.id} did not match its digest`);
  }

  return body;
}

/** Unpacks the layer into `target`, refusing anything that escapes it. */
export async function unpackLayer(body: Buffer, target: string): Promise<void> {
  await fsp.mkdir(target, { recursive: true });
  const root = await fsp.realpath(target);

  const tar = extract.extract();

  /** Where a refusal is recorded.
   *
   *  One place, deliberately. The first version rejected a `finish`/`error`
   *  promise AND let `pipeline` reject, so a hostile archive produced two
   *  rejections for one problem -- one of which nothing was awaiting, which
   *  Node reports as an unhandled rejection and, in a server, is a process
   *  that exits. The entry handler records the reason and destroys the stream
   *  with no argument; `pipeline` then fails with a premature close, and this
   *  is what turns that back into the real message.
   */
  // A holder rather than a bare `let`: only the entry callback assigns it, so
  // control-flow analysis narrows a plain variable to `null` at every read
  // here and `throw` becomes "throwing null" -- which the linter is right
  // about and which would have thrown the wrong thing.
  const failure: { error: Error | null } = { error: null };

  /** The entry handlers, chained.
   *
   *  `tar-stream` hands each entry to a callback that signals completion by
   *  calling `next()`, so the handler below is necessarily async and
   *  fire-and-forget. That leaves a race the first version of this had and the
   *  tests caught: for an archive whose ONLY entry is a bad one, `pipeline`
   *  can resolve before the handler has recorded why it refused -- and the
   *  refusal is then read too early and the archive is accepted. Awaiting this
   *  after the pipeline is what makes the check deterministic rather than
   *  usually right.
   */
  let handled: Promise<void> = Promise.resolve();

  tar.on("entry", (header, stream, next) => {
    handled = handled.then(async () => {
      try {
        // Resolved against the root and checked to be inside it. This archive
        // is about to be executed as root, so `../../etc/cron.d/x` is not a
        // theoretical entry.
        const resolved = path.resolve(root, header.name);
        if (resolved !== root && !resolved.startsWith(root + path.sep)) {
          throw new FeatureError("That feature's archive tries to escape its folder");
        }

        // A symlink pointing out of the tree is the same attack wearing a hat,
        // and nothing in a feature needs one. Skipped rather than refused: an
        // archive that happens to carry one is not necessarily hostile, and
        // the file it would have pointed at is simply not created.
        if (header.type === "symlink" || header.type === "link") {
          stream.resume();
          next();
          return;
        }

        if (header.type === "directory") {
          await fsp.mkdir(resolved, { recursive: true });
          stream.resume();
          next();
          return;
        }

        await fsp.mkdir(path.dirname(resolved), { recursive: true });
        await pipeline(stream, createWriteStream(resolved, { mode: header.mode ?? 0o644 }));
        next();
      } catch (error) {
        failure.error = error instanceof Error ? error : new Error(String(error));
        // No argument: destroying WITH one emits `error` as well, which is the
        // second rejection this exists to avoid.
        tar.destroy();
      }
    });
  });

  try {
    await pipeline(Readable.from(body), createGunzip(), tar);
  } catch (error) {
    // The premature close caused by the destroy above, or a genuinely broken
    // archive. `failure` distinguishes them, and it is the one worth reporting
    // -- after the handlers have finished, or the reason may not be recorded
    // yet.
    await handled;
    if (failure.error) throw failure.error;
    throw error instanceof Error ? error : new Error(String(error));
  }

  await handled;
  if (failure.error) throw failure.error;
}

/** Everything a build needs about one Feature. */
export interface FetchedFeature {
  ref: FeatureRef;
  /** The digest actually fetched, so a build can be cached on it and a rebuild
   *  of the same tag that has since moved is not mistaken for a cache hit. */
  digest: string;
  /** Where it was unpacked. */
  directory: string;
  metadata: FeatureMetadata;
}

export async function fetchFeature(
  ref: FeatureRef,
  into: string,
): Promise<FetchedFeature> {
  const digest = await resolveLayer(ref);
  const body = await readLayer(ref, digest);

  const directory = path.join(into, digest.replace(":", "-"));
  await unpackLayer(body, directory);

  let metadata: FeatureMetadata;
  try {
    metadata = JSON.parse(
      await fsp.readFile(path.join(directory, "devcontainer-feature.json"), "utf8"),
    ) as FeatureMetadata;
  } catch {
    throw new FeatureError(`${ref.id} has no devcontainer-feature.json`);
  }

  try {
    await fsp.access(path.join(directory, "install.sh"));
  } catch {
    throw new FeatureError(`${ref.id} has no install.sh`);
  }

  logger.info("fetched a dev container feature", { id: ref.id, digest });
  return { ref, digest, directory, metadata };
}
