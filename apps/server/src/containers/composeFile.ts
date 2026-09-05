import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { projectRoot } from "../utils/projectPaths.js";
import { isValidImageReference } from "./devcontainer.js";

/** Reading a project's own `docker-compose.yml`.
 *
 *  plan.md §11.3. A very large share of real repositories are not "an app" —
 *  they are an app, a Postgres, a Redis and sometimes a worker, wired together
 *  in a compose file, and `docker compose up` is the documented way to start
 *  them. Until this existed such a repository opened in the editor, showed its
 *  `docker-compose.yml` with a Docker icon, and could not be run at all: three
 *  keys in `devcontainer.ts` refused with *"This platform runs one container
 *  per project."*
 *
 *  **This is not compose support, and the difference is the whole design.**
 *  What is implemented is the relationship §6 decision 4 already built for the
 *  managed database, generalised from one sidecar to several: the project's own
 *  container is the app, and the services the file declares beside it are
 *  started and stopped with it as one lifecycle unit. A `build:` service is
 *  therefore not run — the project's container already is that service — and
 *  everything about how the app container is made stays where it was.
 *
 *  **Why parse it rather than shell out to `docker compose`.** Handing the
 *  daemon a file out of a cloned repository is handing it `privileged: true`,
 *  `network_mode: host`, `pid: host` and `volumes: ["/:/host"]` — an
 *  arbitrary-container-run primitive on the host, from a repository the
 *  platform did not write. Validating every key first is the only safe version
 *  of that, and once every key is validated the file has been parsed anyway.
 *  So: a deliberate SUBSET, refused loudly rather than ignored quietly,
 *  exactly as `devcontainer.ts` does — and for the same reason, that a config
 *  which is half-applied is worse than one that is rejected, because the user
 *  cannot tell which half ran.
 */

/** The filenames compose looks in, in the order it looks. */
export const COMPOSE_PATHS = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

export class ComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeError";
  }
}

/** One service this platform will run beside the project's container. */
export interface ComposeService {
  /** The key in the file. Also the hostname the app reaches it at. */
  name: string;
  image: string;
  env: Record<string, string>;
  /** Overriding the image's own entrypoint arguments. */
  command?: string[];
  /** Named volumes only. A host path is refused — see `parseVolumes`. */
  volumes: { volume: string; target: string }[];
  /** Container ports the file mentioned. Nothing is published to the host;
   *  this is what the editor shows so somebody can see where to connect. */
  ports: number[];
}

export interface ComposeProject {
  /** Which of COMPOSE_PATHS this came from. */
  source: string;
  services: ComposeService[];
  /** The service the file describes as the app itself — the one with a
   *  `build:`. Named rather than started: the project's own container is that
   *  service, and saying so is what stops this looking like a service that was
   *  silently dropped. */
  appService: string | null;
  /** What was present, understood, and not acted on — with the reason, in the
   *  user's terms. Shown in project settings. */
  unsupported: { key: string; reason: string }[];
}

/* ---- what is refused, and why, in the user's terms ---- */

/** Per-service keys that would hand a repository control of the host. Each of
 *  these is the reason this file parses rather than shelling out. */
const SERVICE_REFUSALS: Record<string, string> = {
  privileged: "A privileged container is never permitted here.",
  cap_add:
    "Adding capabilities is never permitted here; every sandbox drops all of them.",
  security_opt:
    "Security options are set by this platform and are not overridable.",
  devices: "Passing host devices through is not supported.",
  network_mode:
    '"network_mode" is not supported. Services run on a private network with ' +
    "the project's own container and are reachable from it by service name.",
  pid: '"pid" is not supported — sharing a process namespace with the host or ' +
    "another container would defeat the sandbox.",
  ipc: '"ipc" is not supported, for the same reason as "pid".',
  userns_mode: "The user namespace is set by this platform.",
  cgroup_parent: "Resource limits are set by this platform.",
  sysctls: "Kernel parameters are not settable from a project.",
  container_name:
    '"container_name" is not supported: this platform names service ' +
    "containers so that two projects declaring the same service do not collide.",
  extends:
    '"extends" is not supported — it reads a second file, which this does not ' +
    "follow.",
  env_file:
    '"env_file" is not supported. Put the values in this project\'s ' +
    "environment variables, where they are stored encrypted rather than " +
    "committed.",
  build:
    "Only one buildable service is supported, and it is this project itself.",
  deploy:
    '"deploy" describes a Swarm rollout, which this platform does not run.',
  secrets: "Compose secrets are not supported; use project environment variables.",
  configs: "Compose configs are not supported.",
  profiles:
    '"profiles" is not supported — every declared service is started, or none is.',
  scale: "Running more than one copy of a service is not supported.",
};

/** Top-level keys refused with a reason of their own. */
const TOP_LEVEL_REFUSALS: Record<string, string> = {
  secrets: "Compose secrets are not supported; use project environment variables.",
  configs: "Compose configs are not supported.",
  include: '"include" reads a second file, which this does not follow.',
};

/** Present in real files, understood, and deliberately not acted on. Listing
 *  them keeps them out of `unsupported`, which is for things a user should do
 *  something about. */
const SERVICE_IGNORED = new Set([
  "restart",
  "depends_on",
  "healthcheck",
  "labels",
  "networks",
  "hostname",
  "tty",
  "stdin_open",
  "working_dir",
  "user",
  "platform",
  "init",
  "stop_grace_period",
  "stop_signal",
  "logging",
  "expose",
  "shm_size",
  "ulimits",
]);

const TOP_LEVEL_IGNORED = new Set([
  "version",
  "name",
  "services",
  "volumes",
  "networks",
]);

/* ---- parsing the shapes compose allows ---- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `environment` is a map or a list of `KEY=value`, and compose accepts both.
 *
 *  A bare `KEY` in the list form means "take it from the host environment",
 *  which this deliberately does NOT do: the host here is the platform's own
 *  server process, and passing its environment into a container out of a
 *  cloned repository is how a JWT secret ends up in somebody's Postgres.
 *  Dropped rather than refused, because the file is not wrong — the answer
 *  simply is not available here.
 */
function parseEnvironment(value: unknown, service: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (value === undefined || value === null) return env;

  if (isRecord(value)) {
    for (const [key, raw] of Object.entries(value)) {
      if (raw === null || raw === undefined) continue;
      // Each scalar YAML can produce, named rather than narrowed away from
      // `unknown`: a value that stringifies to "[object Object]" would reach
      // Docker as a variable saying nothing, which is worse than a refusal.
      if (typeof raw === "string") env[key] = raw;
      else if (typeof raw === "number") env[key] = String(raw);
      else if (typeof raw === "boolean") env[key] = String(raw);
      else {
        throw new ComposeError(
          `Service "${service}" has a non-scalar value for environment variable "${key}".`,
        );
      }
    }
    return env;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string") {
        throw new ComposeError(
          `Service "${service}" has a non-string entry in "environment".`,
        );
      }
      const split = entry.indexOf("=");
      // A bare name asks for the host's value. See the note above.
      if (split <= 0) continue;
      env[entry.slice(0, split)] = entry.slice(split + 1);
    }
    return env;
  }

  throw new ComposeError(
    `Service "${service}" has an "environment" that is neither a map nor a list.`,
  );
}

/** `command` is a string or a list, and compose accepts both.
 *
 *  The string form is shell-quoted in real compose. This does NOT run it
 *  through a shell — it splits on whitespace and refuses anything with shell
 *  metacharacters in it, because a command assembled here is passed to the
 *  daemon rather than to `sh`, and quietly ignoring a `&&` would run half of
 *  what the file asked for.
 */
function parseCommand(value: unknown, service: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;

  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry !== "string" && typeof entry !== "number") {
        throw new ComposeError(
          `Service "${service}" has a non-string entry in "command".`,
        );
      }
      return String(entry);
    });
  }

  if (typeof value !== "string") {
    throw new ComposeError(
      `Service "${service}" has a "command" that is neither a string nor a list.`,
    );
  }

  if (/[|&;<>$`\\"']/.test(value)) {
    throw new ComposeError(
      `Service "${service}" has a "command" with shell syntax in it. This ` +
        "platform passes the command straight to the container rather than " +
        "through a shell; write it as a list, or put the shell invocation in " +
        "the list explicitly.",
    );
  }

  const parts = value.split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

/** `volumes` in short (`name:/path`) or long (`{type, source, target}`) form.
 *
 *  **Named volumes only.** A host path — `./data:/var/lib/postgresql/data`,
 *  which is extremely common in real files — is refused, because a bind mount
 *  chosen by a cloned repository is the whole host filesystem one `..` away.
 *  Refused rather than silently rewritten to a volume: the two behave
 *  differently the first time somebody looks for the files on disk, and a
 *  quietly-relocated data directory is a nastier surprise than a message.
 */
function parseVolumes(
  value: unknown,
  service: string,
  declared: Set<string>,
  unsupported: { key: string; reason: string }[],
): { volume: string; target: string }[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ComposeError(`Service "${service}" has a "volumes" that is not a list.`);
  }

  const out: { volume: string; target: string }[] = [];

  for (const entry of value) {
    let source: string | undefined;
    let target: string | undefined;

    if (typeof entry === "string") {
      const parts = entry.split(":");
      if (parts.length === 1) {
        // An anonymous volume. Harmless and common; nothing to name.
        continue;
      }
      source = parts[0];
      target = parts[1];
    } else if (isRecord(entry)) {
      const kind = entry["type"];
      if (kind !== undefined && kind !== "volume") {
        unsupported.push({
          key: `services.${service}.volumes`,
          reason:
            "Only named volumes are mounted into a service" +
            (typeof kind === "string" ? `, and a "${kind}" mount was ignored.` : "."),
        });
        continue;
      }
      source = typeof entry["source"] === "string" ? entry["source"] : undefined;
      target = typeof entry["target"] === "string" ? entry["target"] : undefined;
    } else {
      throw new ComposeError(`Service "${service}" has an unreadable volume entry.`);
    }

    if (!source || !target) continue;

    // Anything that looks like a path rather than a name.
    if (source.startsWith(".") || source.startsWith("/") || source.startsWith("~") ||
        /^[A-Za-z]:[\\/]/.test(source)) {
      unsupported.push({
        key: `services.${service}.volumes`,
        reason:
          `"${source}" is a host path, and a service may only mount named ` +
          "volumes here. Declare it under the top-level \"volumes:\" key and " +
          "use that name instead.",
      });
      continue;
    }

    if (!declared.has(source)) {
      unsupported.push({
        key: `services.${service}.volumes`,
        reason: `"${source}" is not declared under the top-level "volumes:" key, so it was not mounted.`,
      });
      continue;
    }

    out.push({ volume: source, target });
  }

  return out;
}

/** `ports` in any of compose's forms, reduced to the CONTAINER port.
 *
 *  Nothing is published to the host — exactly as project and database
 *  containers publish nothing — so the host side of `"5432:5432"` is dropped
 *  rather than honoured. The container port is kept because it is what the
 *  editor shows: "reachable at postgres:5432" is the useful sentence.
 */
function parsePorts(value: unknown): number[] {
  if (!Array.isArray(value)) return [];

  const ports: number[] = [];

  for (const entry of value) {
    let candidate: string | undefined;

    if (typeof entry === "number") candidate = String(entry);
    else if (typeof entry === "string") candidate = entry;
    else if (isRecord(entry)) {
      const target = entry["target"];
      if (typeof target === "string") candidate = target;
      else if (typeof target === "number") candidate = String(target);
    }
    if (!candidate) continue;

    // "127.0.0.1:8080:80/tcp" -> the container side is the last colon field.
    const withoutProtocol = candidate.split("/")[0] ?? "";
    const fields = withoutProtocol.split(":");
    const container = fields[fields.length - 1] ?? "";
    // A range ("3000-3005") is not a port; the first of it is close enough for
    // a label and wrong enough to leave alone.
    if (container.includes("-")) continue;

    const port = Number(container);
    if (Number.isInteger(port) && port > 0 && port < 65536) ports.push(port);
  }

  return ports;
}

/* ---- the file as a whole ---- */

/** Turns parsed YAML into what this platform will actually do. */
export function interpretCompose(input: unknown, source: string): ComposeProject {
  if (!isRecord(input)) {
    throw new ComposeError(`${source} is not a compose file — it has no top-level keys.`);
  }

  const project: ComposeProject = {
    source,
    services: [],
    appService: null,
    unsupported: [],
  };

  for (const key of Object.keys(input)) {
    if (TOP_LEVEL_IGNORED.has(key) || key.startsWith("x-")) continue;
    project.unsupported.push({
      key,
      reason: TOP_LEVEL_REFUSALS[key] ?? `"${key}" is not read by this platform.`,
    });
  }

  const services = input["services"];
  if (!isRecord(services)) {
    throw new ComposeError(`${source} declares no services.`);
  }

  const declaredVolumes = new Set(
    isRecord(input["volumes"]) ? Object.keys(input["volumes"]) : [],
  );

  for (const [name, raw] of Object.entries(services)) {
    if (!isRecord(raw)) {
      throw new ComposeError(`Service "${name}" in ${source} is not a mapping.`);
    }

    // The app itself. Named, not started, and not counted against the service
    // limit: the project's own container already plays this part.
    if (raw["build"] !== undefined) {
      if (project.appService === null) {
        project.appService = name;
      } else {
        project.unsupported.push({
          key: `services.${name}.build`,
          reason:
            `Only one buildable service is supported, and "${project.appService}" ` +
            "was taken as this project itself.",
        });
      }
      continue;
    }

    for (const key of Object.keys(raw)) {
      const known =
        key === "image" ||
        key === "environment" ||
        key === "command" ||
        key === "volumes" ||
        key === "ports" ||
        SERVICE_IGNORED.has(key) ||
        key.startsWith("x-");
      if (known) continue;

      project.unsupported.push({
        key: `services.${name}.${key}`,
        reason: SERVICE_REFUSALS[key] ?? `"${key}" is not read by this platform.`,
      });
    }

    const image = raw["image"];
    if (typeof image !== "string" || image.trim() === "") {
      throw new ComposeError(
        `Service "${name}" has no "image". A service without one would have to ` +
          "be built, and this platform builds only the project itself.",
      );
    }
    if (!isValidImageReference(image.trim())) {
      throw new ComposeError(`Service "${name}" has an image name that is not valid: "${image}".`);
    }

    project.services.push({
      name,
      image: image.trim(),
      env: parseEnvironment(raw["environment"], name),
      ...(parseCommand(raw["command"], name)
        ? { command: parseCommand(raw["command"], name) }
        : {}),
      volumes: parseVolumes(raw["volumes"], name, declaredVolumes, project.unsupported),
      ports: parsePorts(raw["ports"]),
    });
  }

  return project;
}

/** Reads a project's compose file, or null when it has none.
 *
 *  Read from the HOST rather than through an exec, for the reason
 *  `readDevcontainer` is: the project tree is a bind mount, so these are the
 *  same bytes the container would see, and this runs before there is a
 *  container to ask.
 */
export async function readCompose(projectId: string): Promise<ComposeProject | null> {
  const root = projectRoot(projectId);

  for (const relative of COMPOSE_PATHS) {
    const text = await readFile(path.join(root, relative), "utf8").catch(() => null);
    if (text === null) continue;

    let parsed: unknown;
    try {
      // `merge: true` for the `<<: *anchor` key. It is a YAML 1.1 feature the
      // parser leaves off by default, and compose files use it constantly to
      // share a block between services -- without it a service written that
      // way parses to an empty mapping and is refused for "has no image",
      // which is a confusing thing to be told about a file that works
      // everywhere else. Found by a test rather than by a bug report.
      parsed = parse(text, { merge: true });
    } catch (error) {
      throw new ComposeError(
        `${relative} is not valid YAML: ${error instanceof Error ? error.message : "unreadable"}`,
      );
    }

    return interpretCompose(parsed, relative);
  }

  return null;
}
