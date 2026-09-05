import { readFile } from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "../utils/projectPaths.js";

/** Reading a project's own `.devcontainer/devcontainer.json`.
 *
 *  Every project here gets one of three images chosen by its template, and that
 *  is the most common reason a real repository will not run: a project needing
 *  `ffmpeg`, `libvips`, a Postgres client or a different Node version has no way
 *  to say so. Replit answers this with `replit.nix`, CodeSandbox with the
 *  devcontainer spec — and the devcontainer spec is the better target, because
 *  it is a standard that VS Code and GitHub Codespaces already read, so a
 *  repository that carries one works here without being modified for here.
 *
 *  This implements a deliberate SUBSET, and refuses the rest loudly rather than
 *  ignoring it quietly — a config that is half-applied is worse than one that is
 *  rejected, because the user cannot tell which half ran. What is left out and
 *  why is recorded on `unsupported`, which the editor shows.
 */

/** The filenames the spec looks in, in the order it looks. */
export const DEVCONTAINER_PATHS = [
  ".devcontainer/devcontainer.json",
  ".devcontainer.json",
];

/** Keys this understands. Anything else present is reported as unsupported. */
const SUPPORTED_KEYS = new Set([
  "name",
  "image",
  "containerEnv",
  "forwardPorts",
  "postCreateCommand",
  "postStartCommand",
  "workspaceFolder",
  // Read and deliberately ignored — see `IGNORED` below.
  "remoteUser",
  "containerUser",
  "updateRemoteUserUID",
  "customizations",
  "settings",
  "extensions",
  "shutdownAction",
  "$schema",
  "remoteEnv",
]);

/** Present in real configs, understood, and deliberately not acted on.
 *
 *  Each of these would either break the bind mount or promise something this
 *  platform does not have. Listing them keeps them out of `unsupported`, which
 *  is for things a user should act on.
 */
const IGNORED = new Set([
  "name",
  "remoteUser",
  "containerUser",
  "updateRemoteUserUID",
  "customizations",
  "settings",
  "extensions",
  "shutdownAction",
  "$schema",
]);

/** What this deployment and this account will honour.
 *
 *  Passed in rather than read from a flag inside this module, because §6
 *  decision 13's argument applies unchanged: a rule enforced by a mode flag
 *  consulted deep in a parser is a rule that usually holds. Here the caller
 *  resolves the entitlement once and hands down the answer, so a call site
 *  that forgets gets the SAFE behaviour -- the default is nothing granted.
 */
export interface DevcontainerCapabilities {
  /** Whether `mounts` is read at all. False refuses it exactly as before. */
  mounts: boolean;
}

/** Nothing granted. The default, and deliberately the safe one. */
const NOTHING: DevcontainerCapabilities = { mounts: false };

/** One entry of `mounts`, as asked for. Whether it is ALLOWED is a question
 *  about the host and is answered in devcontainerMounts.ts; this is only the
 *  shape. */
export interface DevcontainerMount {
  type: string;
  source: string;
  target: string;
  readOnly: boolean;
}

export interface DevcontainerConfig {
  /** Which file it was read from, for error messages. */
  source: string;
  image?: string;
  containerEnv?: Record<string, string>;
  forwardPorts?: number[];
  postCreateCommand?: string[];
  postStartCommand?: string[];
  workspaceFolder?: string;
  /** Extra host directories the file asked to have mounted. Present only when
   *  the caller said mounts may be read; every one is still checked against
   *  the deployment's allowlist before it reaches Docker. */
  mounts?: DevcontainerMount[];
  /** Keys present that this does not act on, with the reason. Shown to the
   *  user, because silently ignoring half a config is how somebody spends an
   *  afternoon wondering why their Dockerfile did nothing. */
  unsupported: { key: string; reason: string }[];
}

/** Why each unsupported key is unsupported, in the user's terms. */
const REFUSALS: Record<string, string> = {
  build:
    "Building an image from a Dockerfile is not supported here. Set \"image\" " +
    "to a permitted base image instead.",
  dockerFile:
    "Building an image from a Dockerfile is not supported here. Set \"image\" " +
    "to a permitted base image instead.",
  // These three said "This platform runs one container per project" until
  // plan.md §11.3, and that sentence is no longer true: a project's own
  // docker-compose.yml now starts the services it declares beside the
  // project's container. What is still not supported is the devcontainer
  // spec's compose INTEGRATION, which is a different thing -- it asks this
  // platform to build the app container out of a compose service, and the app
  // container here is the project's, made the way every other project's is.
  dockerComposeFile:
    "A devcontainer cannot describe the app container through Compose here. " +
    "The project's own docker-compose.yml is read separately, and the " +
    "services it declares are started beside this project — see project " +
    "settings.",
  service:
    "\"service\" names which Compose service the devcontainer IS, which this " +
    "platform does not do: the project's own container is the app.",
  runServices:
    "\"runServices\" is not read. Every service in the project's " +
    "docker-compose.yml that this deployment permits is started.",
  features:
    "Dev Container Features are not supported. Install what you need in " +
    "\"postCreateCommand\" instead.",
  mounts:
    "Extra mounts are not supported: the project directory is the only thing " +
    "mounted, deliberately.",
  runArgs:
    "\"runArgs\" is not supported — the container's resource limits and " +
    "security options are set by this platform and are not overridable.",
  privileged:
    "A privileged container is never permitted here.",
  capAdd:
    "Adding capabilities is never permitted here; the sandbox drops all of them.",
  securityOpt:
    "Security options are set by this platform and are not overridable.",
  initializeCommand:
    "\"initializeCommand\" runs on the HOST, which this platform does not do.",
  onCreateCommand:
    "Not supported. Use \"postCreateCommand\", which runs at the same point " +
    "for this platform's purposes.",
  postAttachCommand:
    "Not supported: there is no attach step here — a terminal opens an exec.",
  waitFor: "Not supported; lifecycle commands always run in order.",
  appPort:
    "Deprecated in the spec and not supported. Use \"forwardPorts\".",
  workspaceMount:
    "The project directory's mount point is fixed by this platform.",
};

/* ---- JSONC ---- */

/** Strips comments and trailing commas.
 *
 *  `devcontainer.json` is JSONC by specification and real ones are full of
 *  comments, so `JSON.parse` alone rejects the majority of files people
 *  actually have. This walks the text rather than running a regex over it,
 *  because a `//` inside a string is not a comment and a regex cannot tell —
 *  which would silently truncate a URL in an image name.
 */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? "";
    const next = text[i + 1] ?? "";

    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }

    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      out += char;
      // A backslash escapes the next character, including a quote — without
      // this, "C:\\path\\" would be read as an unterminated string.
      if (char === "\\") {
        out += next;
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }

    out += char;
  }

  // Trailing commas, now that no comma inside a string can be mistaken for one.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/* ---- parsing ---- */

export class DevcontainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevcontainerError";
  }
}

function asStringArray(value: unknown, key: string): string[] {
  // The spec allows a string (run through a shell), an array (argv), or an
  // object of named commands. All three are normalised to one shell command
  // per entry, run in order.
  if (typeof value === "string") return [value];

  if (Array.isArray(value)) {
    if (!value.every((entry) => typeof entry === "string")) {
      throw new DevcontainerError(`"${key}" must be a string or an array of strings`);
    }
    // An argv array is one command, quoted back into a single string so it
    // reaches the shell as the spec intends.
    return [value.map(shellQuote).join(" ")];
  }

  if (value && typeof value === "object") {
    const entries = Object.values(value as Record<string, unknown>);
    if (!entries.every((entry) => typeof entry === "string" || Array.isArray(entry))) {
      throw new DevcontainerError(`"${key}" has an entry that is not a command`);
    }
    // The spec runs these in parallel. They are run in order here instead:
    // sequential output can be read, and a failure can be attributed.
    return entries.flatMap((entry) => asStringArray(entry, key));
  }

  throw new DevcontainerError(`"${key}" must be a string, an array, or an object`);
}

/** Quotes one argv entry for a POSIX shell. */
function shellQuote(argument: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(argument)
    ? argument
    : `'${argument.replace(/'/g, `'\\''`)}'`;
}

/** Reads `mounts`, in both forms the spec allows.
 *
 *  The string form is a comma-separated list of `key=value` -- Docker's own
 *  `--mount` syntax, which is what the spec borrowed. The object form is the
 *  same keys as JSON. Both appear in real repositories, so both are read.
 *
 *  `${localWorkspaceFolder}` is expanded because it is by far the most common
 *  thing a real config puts here and refusing it would fail the ordinary case.
 *  `${localEnv:...}` deliberately is NOT: it would let a file in a repository
 *  read this server's environment, which is where the database URL and every
 *  secret lives, and no amount of path confinement afterwards makes that a
 *  good idea.
 */
function parseMounts(raw: unknown): DevcontainerMount[] {
  const entries = Array.isArray(raw) ? raw : [raw];
  const mounts: DevcontainerMount[] = [];

  for (const entry of entries) {
    const fields: Record<string, string> = {};

    if (typeof entry === "string") {
      for (const part of entry.split(",")) {
        const [key, ...rest] = part.split("=");
        if (!key || rest.length === 0) {
          throw new DevcontainerError(
            `"mounts" has an entry that is not key=value: ${JSON.stringify(entry)}`,
          );
        }
        fields[key.trim()] = rest.join("=").trim();
      }
    } else if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
        if (typeof value !== "string" && typeof value !== "boolean") {
          throw new DevcontainerError(`"mounts.${key}" must be a string`);
        }
        fields[key] = String(value);
      }
    } else {
      throw new DevcontainerError(
        `"mounts" entries must be strings or objects, not ${JSON.stringify(entry)}`,
      );
    }

    const source = fields["source"] ?? fields["src"];
    const target = fields["target"] ?? fields["destination"] ?? fields["dst"];

    if (!source || !target) {
      throw new DevcontainerError(
        `"mounts" needs both a source and a target: ${JSON.stringify(entry)}`,
      );
    }

    mounts.push({
      // Defaulted to bind, as Docker does, so the common shorthand works.
      type: (fields["type"] ?? "bind").toLowerCase(),
      source: expandWorkspace(source),
      target: expandWorkspace(target),
      readOnly: fields["readonly"] === "true" || fields["readOnly"] === "true",
    });
  }

  return mounts;
}

/** The one variable this expands. See `parseMounts` for why it is the one. */
function expandWorkspace(value: string): string {
  return value.replaceAll("${localWorkspaceFolder}", MOUNT_POINT_LITERAL);
}

/** The workspace path, written out rather than imported.
 *
 *  `containerManager` exports MOUNT_POINT and imports this module, so reading
 *  it from there would be a cycle. It has never changed -- it is described in
 *  containerManager as fixed by this platform -- and the constant here is
 *  asserted against it in the tests so the two cannot drift silently.
 */
const MOUNT_POINT_LITERAL = "/home/sandbox/app";

/** Turns the parsed JSON into the subset this acts on.
 *
 *  Exported and pure: the rules are the part worth pinning, and none of them
 *  need a container or a filesystem to exercise.
 */
export function interpret(
  raw: unknown,
  source: string,
  allowed: DevcontainerCapabilities = NOTHING,
): DevcontainerConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DevcontainerError(`${source} must contain a JSON object`);
  }

  const input = raw as Record<string, unknown>;
  const config: DevcontainerConfig = { source, unsupported: [] };

  for (const key of Object.keys(input)) {
    if (SUPPORTED_KEYS.has(key)) continue;
    // Understood on this plan, so not a refusal to report.
    if (key === "mounts" && allowed.mounts) continue;
    config.unsupported.push({
      key,
      reason:
        REFUSALS[key] ?? `"${key}" is not supported by this platform and was ignored.`,
    });
  }

  if (input["image"] !== undefined) {
    if (typeof input["image"] !== "string" || !input["image"].trim()) {
      throw new DevcontainerError(`"image" must be a non-empty string`);
    }
    config.image = input["image"].trim();
  }

  // `remoteEnv` and `containerEnv` differ in the spec — one applies to the
  // container, one to processes started in it. Everything here is started with
  // `docker exec` off the same container, so the distinction has no effect and
  // both are merged, container-level last.
  const envSources = [input["remoteEnv"], input["containerEnv"]];
  const merged: Record<string, string> = {};
  for (const source_ of envSources) {
    if (source_ === undefined) continue;
    if (typeof source_ !== "object" || source_ === null || Array.isArray(source_)) {
      throw new DevcontainerError(`"containerEnv" must be an object`);
    }
    for (const [key, value] of Object.entries(source_ as Record<string, unknown>)) {
      if (typeof value !== "string") {
        throw new DevcontainerError(
          `"containerEnv.${key}" must be a string; numbers need quoting`,
        );
      }
      merged[key] = value;
    }
  }
  if (Object.keys(merged).length > 0) config.containerEnv = merged;

  if (input["forwardPorts"] !== undefined) {
    if (!Array.isArray(input["forwardPorts"])) {
      throw new DevcontainerError(`"forwardPorts" must be an array`);
    }
    const ports: number[] = [];
    for (const entry of input["forwardPorts"]) {
      // The spec allows "host:port" for a port on another service. There are no
      // other services here, so only a bare port is meaningful.
      const port = typeof entry === "string" ? Number(entry) : entry;
      if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new DevcontainerError(
          `"forwardPorts" has an entry that is not a port: ${JSON.stringify(entry)}`,
        );
      }
      ports.push(port);
    }
    if (ports.length > 0) config.forwardPorts = [...new Set(ports)];
  }

  if (input["postCreateCommand"] !== undefined) {
    config.postCreateCommand = asStringArray(
      input["postCreateCommand"],
      "postCreateCommand",
    );
  }

  if (input["postStartCommand"] !== undefined) {
    config.postStartCommand = asStringArray(
      input["postStartCommand"],
      "postStartCommand",
    );
  }

  if (input["workspaceFolder"] !== undefined) {
    if (typeof input["workspaceFolder"] !== "string") {
      throw new DevcontainerError(`"workspaceFolder" must be a string`);
    }
    config.workspaceFolder = input["workspaceFolder"].trim();
  }

  if (allowed.mounts && input["mounts"] !== undefined) {
    config.mounts = parseMounts(input["mounts"]);
  }

  // Keys understood but not acted on are not the user's problem.
  config.unsupported = config.unsupported.filter((entry) => !IGNORED.has(entry.key));

  return config;
}

/** Reads a project's devcontainer config, or null when it has none.
 *
 *  Read from the HOST rather than through an exec: the project tree is a bind
 *  mount, so these are the same bytes the container would see, and this runs
 *  before there is a container to ask.
 */
export async function readDevcontainer(
  projectId: string,
  allowed?: DevcontainerCapabilities,
): Promise<DevcontainerConfig | null> {
  const root = projectRoot(projectId);

  for (const relative of DEVCONTAINER_PATHS) {
    const text = await readFile(path.join(root, relative), "utf8").catch(() => null);
    if (text === null) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonc(text));
    } catch {
      throw new DevcontainerError(
        `${relative} is not valid JSON. Comments and trailing commas are ` +
          "allowed; something else is wrong.",
      );
    }

    return interpret(parsed, relative, allowed);
  }

  return null;
}

/* ---- which images may be asked for ---- */

/** A Docker reference, loosely: registry/path segments, then an optional tag or
 *  digest. Checked before the allowlist so a value that could not be an image
 *  is refused as malformed rather than as "not permitted", which is a different
 *  thing to tell somebody. */
const IMAGE_SHAPE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/;

export function isValidImageReference(image: string): boolean {
  return image.length > 0 && image.length <= 255 && IMAGE_SHAPE.test(image);
}

/** Whether an image is on the allowlist.
 *
 *  A trailing `*` is a prefix wildcard and the only wildcard there is —
 *  anything cleverer would be a pattern language nobody asked for, in front of
 *  the decision about what code runs in the sandbox.
 */
export function imageAllowed(image: string, allowlist: string[]): boolean {
  return allowlist.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.endsWith("*")) return image.startsWith(pattern.slice(0, -1));
    return image === pattern;
  });
}

/* ---- what happened, for the editor to show ---- */

export interface DevcontainerStatus {
  /** Null when the project has no devcontainer at all. */
  config: DevcontainerConfig | null;
  /** A config that could not be read or could not be honoured. The container
   *  still starts on the template's defaults — being locked out of a project by
   *  a file you are trying to fix is the worst possible failure here — but the
   *  reason has to reach the user, or the file looks like it worked. */
  error: string | null;
  /** Mounts the file asked for that were refused, with the reason. Separate
   *  from `error` because the container started and everything else in the
   *  config was honoured -- this is a partial refusal, and reporting it as a
   *  failure to read the file would be a lie about what happened. */
  refusedMounts: { source: string; reason: string }[];
  /** Combined output of the lifecycle commands from the last start. */
  lifecycleLog: string;
  /** True while those commands are running. */
  running: boolean;
  /** What happened when the account's dotfiles were cloned into this
   *  container, or null when nobody has set any. plan.md §11.9.
   *
   *  Here rather than in a channel of its own because this is already the
   *  "what ran while this container was being made" record, and a dotfiles
   *  repository that failed is indistinguishable from one that was never
   *  configured unless it is reported somewhere. Kept SEPARATE from
   *  `lifecycleLog` because they come from different files owned by different
   *  people -- one from the project, one from the person. */
  dotfilesLog: string | null;
}

const statuses = new Map<string, DevcontainerStatus>();

export function getDevcontainerStatus(projectId: string): DevcontainerStatus {
  return (
    statuses.get(projectId) ?? {
      config: null,
      error: null,
      refusedMounts: [],
      lifecycleLog: "",
      running: false,
      dotfilesLog: null,
    }
  );
}

export function setDevcontainerStatus(
  projectId: string,
  patch: Partial<DevcontainerStatus>,
): void {
  statuses.set(projectId, { ...getDevcontainerStatus(projectId), ...patch });
}

/** Drops a project's status. For deletion, and so a recreated project with the
 *  same id does not inherit the old one's warnings. */
export function forgetDevcontainer(projectId: string): void {
  statuses.delete(projectId);
}

/** Where the container should work, given the config and the fixed mount point.
 *
 *  A `workspaceFolder` outside the mount would put the shell somewhere the
 *  user's files are not, so it is confined rather than trusted — a monorepo
 *  pointing at a subdirectory is the case worth supporting, and `/etc` is not.
 */
export function resolveWorkspaceFolder(
  requested: string | undefined,
  mountPoint: string,
): string {
  if (!requested) return mountPoint;

  // POSIX paths, because this is a path inside a Linux container regardless of
  // the host this server runs on.
  const absolute = requested.startsWith("/")
    ? path.posix.normalize(requested)
    : path.posix.normalize(path.posix.join(mountPoint, requested));

  if (absolute !== mountPoint && !absolute.startsWith(`${mountPoint}/`)) {
    return mountPoint;
  }

  return absolute;
}
