/** Naming a Dev Container Feature, and refusing one that is not named.
 *  plan.md §11.10.
 *
 *  A Feature is an OCI artifact, referenced the way an image is:
 *
 *      ghcr.io/devcontainers/features/node:1
 *      ghcr.io/devcontainers/features/go@sha256:abc...
 *
 *  Parsed here rather than passed through, for the same reason
 *  `isValidImageReference` exists one file over: whatever this accepts decides
 *  what gets downloaded and executed as root in a container on this host, and
 *  a string that reaches a registry client unparsed is a string somebody will
 *  eventually put a newline in.
 *
 *  Deliberately NOT supported, and refused clearly rather than half-honoured:
 *  the `./local-feature` and `https://…tgz` forms in the spec. The first is a
 *  path inside a repository this platform did not write, the second is an
 *  arbitrary URL; both are code fetched from somewhere the deployment's image
 *  allowlist has no say over, which is exactly the decision that allowlist
 *  exists to make.
 */

export interface FeatureRef {
  /** The registry host, e.g. `ghcr.io`. */
  registry: string;
  /** Everything between the host and the tag, e.g.
   *  `devcontainers/features/node`. */
  repository: string;
  /** A tag, or null when pinned by digest. */
  tag: string | null;
  /** `sha256:…`, or null when referenced by tag. */
  digest: string | null;
  /** The reference as written, for messages and cache keys. */
  id: string;
}

export class FeatureError extends Error {}

const HOST = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?$/;
const PATH_SEGMENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

/** Longer than any real reference and short enough that the parser is never
 *  handed a megabyte. */
const MAX_LENGTH = 255;

export function parseFeatureRef(raw: string): FeatureRef {
  const value = raw.trim();

  if (value === "") throw new FeatureError("A feature id cannot be empty");
  if (value.length > MAX_LENGTH) {
    throw new FeatureError("That feature id is too long to be real");
  }
  // Not a character class on the whole string: the point is to name the two
  // shapes this refuses, because "invalid" would send somebody to check their
  // spelling of a form that is never going to work.
  if (value.startsWith("./") || value.startsWith("../")) {
    throw new FeatureError(
      "A feature from a path in the repository is not supported here — " +
        "publish it, or do the work in postCreateCommand",
    );
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    throw new FeatureError(
      "A feature from a URL is not supported here — only a registry this " +
        "deployment permits",
    );
  }

  let rest = value;
  let digest: string | null = null;
  let tag: string | null = null;

  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST.test(digest)) {
      throw new FeatureError("That digest is not a sha256 digest");
    }
  }

  // After the digest split, and searched from the END, so a registry host with
  // a port (`localhost:5000/x`) is not mistaken for a tag.
  const colon = rest.lastIndexOf(":");
  const slash = rest.lastIndexOf("/");
  if (colon > slash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) throw new FeatureError(`"${tag}" is not a valid tag`);
  }

  const parts = rest.split("/");
  const registry = parts.shift() ?? "";

  // A bare `node:1` has no registry. Refused rather than defaulted to Docker
  // Hub: the deployment's allowlist is written in terms of hosts, and quietly
  // supplying one would mean the allowlist governs a host nobody wrote down.
  if (!registry.includes(".") && !registry.includes(":") && registry !== "localhost") {
    throw new FeatureError(
      "A feature id must name its registry, e.g. ghcr.io/devcontainers/features/node:1",
    );
  }
  if (!HOST.test(registry)) {
    throw new FeatureError(`"${registry}" is not a valid registry host`);
  }
  if (parts.length === 0 || parts.some((part) => !PATH_SEGMENT.test(part))) {
    throw new FeatureError(`"${value}" is not a valid feature id`);
  }

  return {
    registry,
    repository: parts.join("/"),
    tag: digest === null ? (tag ?? "latest") : tag,
    digest,
    id: value,
  };
}

/** Whether a feature's registry is one this deployment permits.
 *
 *  Matched on the HOST, not on the whole reference, and that is the difference
 *  between this and `imageAllowed`: an image allowlist is about which base
 *  images may run, and this is about whose code may be executed as root during
 *  a build. A host is the coarsest thing an operator can reason about, and the
 *  coarsest is the right grain for a list somebody has to actually maintain.
 */
export function featureRegistryAllowed(
  ref: FeatureRef,
  allowlist: readonly string[],
): boolean {
  return allowlist.some((entry) => entry === "*" || entry === ref.registry);
}
