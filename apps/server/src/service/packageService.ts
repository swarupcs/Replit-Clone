import { readFile } from "node:fs/promises";
import {
  MANIFEST_BY_ECOSYSTEM,
  MAX_PACKAGE_NAME,
  MAX_PACKAGE_VERSION,
  type Ecosystem,
  type PackageEntry,
  type PackageList,
} from "@replit-clone/shared";
import { ensureContainer } from "../containers/containerManager.js";
import { execCapture } from "../containers/execCapture.js";
import { assertValidProjectId, resolveInProject } from "../utils/projectPaths.js";
import { BadRequestError } from "../utils/errors.js";

const APP_DIR = "/home/sandbox/app";

/** Ecosystems in the order their manifests are looked for.
 *
 *  A project could carry more than one — a Python service with a package.json
 *  for its frontend tooling is ordinary. The first match wins rather than the
 *  UI trying to present two package managers at once; npm leads because eight
 *  of the twelve templates are Node. */
const DETECTION_ORDER: Ecosystem[] = ["npm", "pip", "go"];

/* ---- names ---- */

/** What each ecosystem allows in a dependency name.
 *
 *  These are deliberately tighter than each registry's own rules. The name
 *  reaches a shell-less `exec` as one argv entry, so it cannot be used to run a
 *  second command — but it CAN still be read as an option by the tool itself,
 *  and npm in particular will happily install from a path, a tarball URL or a
 *  git remote if the "name" looks like one. Restricting the shape to something
 *  that can only be a registry name keeps this endpoint from becoming a way to
 *  fetch and execute arbitrary code inside the sandbox. */
const NAME_PATTERN = {
  // Optional @scope/, then the package. No slashes beyond the scope separator,
  // which rules out a relative path.
  npm: /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i,
  pip: /^[a-z0-9][a-z0-9._-]*$/i,
  // A module path is host/user/repo — slashes are meaningful here, and dots
  // appear in the host. `..` is rejected separately below.
  go: /^[a-z0-9][a-z0-9._~-]*(\.[a-z0-9._~-]+)+(\/[a-z0-9._~-]+)*$/i,
} as const satisfies Record<Ecosystem, RegExp>;

/** Indexed through a function so the lookup is total: a `Record` read under
 *  `noUncheckedIndexedAccess` is `RegExp | undefined`, and there is no third
 *  ecosystem for it to be undefined for. */
function namePattern(ecosystem: Ecosystem): RegExp {
  return NAME_PATTERN[ecosystem];
}

/** A version specifier, or nothing at all.
 *
 *  Ranges, tags and pins only: "^19.0.0", ">=3,<4", "latest", "==2.31.0".
 *  Anything that could name a location — a slash, a colon, an @ — is refused,
 *  for the same reason the name pattern is tight. A leading comparator is
 *  allowed and a leading dash is not, though only for tidiness: the version is
 *  concatenated onto the name rather than passed as its own argv entry, so it
 *  could not be read as a flag either way. */
const VERSION_PATTERN = /^[a-z0-9^~<>=!*][a-z0-9.*+~^<>=!,\s-]*$/i;

export function assertValidName(ecosystem: Ecosystem, name: string): string {
  const trimmed = name.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_PACKAGE_NAME) {
    throw new BadRequestError("That is not a package name", "BAD_PACKAGE_NAME");
  }

  // Checked before the pattern so the message is about the actual problem: a
  // leading dash is read as an option by every one of these tools.
  if (trimmed.startsWith("-")) {
    throw new BadRequestError(
      "A package name cannot start with a dash",
      "BAD_PACKAGE_NAME",
    );
  }

  if (trimmed.includes("..") || !namePattern(ecosystem).test(trimmed)) {
    throw new BadRequestError(
      `"${trimmed}" is not a ${ecosystem} package name. Install from a URL or a ` +
        "local path in the terminal, where it is clear what is being run.",
      "BAD_PACKAGE_NAME",
    );
  }

  return trimmed;
}

export function assertValidVersion(version: string): string {
  const trimmed = version.trim();

  if (trimmed.length === 0) return "";

  if (trimmed.length > MAX_PACKAGE_VERSION || !VERSION_PATTERN.test(trimmed)) {
    throw new BadRequestError(
      `"${trimmed}" is not a version specifier`,
      "BAD_PACKAGE_VERSION",
    );
  }

  return trimmed;
}

/* ---- reading ---- */

/** npm writes dependencies as an object of name -> range. */
export function parsePackageJson(raw: string): PackageEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A manifest mid-edit is not an error worth failing the panel over — the
    // user is probably typing in it right now.
    return [];
  }

  if (typeof parsed !== "object" || parsed === null) return [];
  const manifest = parsed as Record<string, unknown>;

  const collect = (key: string, dev: boolean): PackageEntry[] => {
    const section = manifest[key];
    if (typeof section !== "object" || section === null) return [];

    return Object.entries(section as Record<string, unknown>)
      .filter(([, version]) => typeof version === "string")
      .map(([name, version]) => ({
        name,
        version: version as string,
        ...(dev ? { dev: true } : {}),
      }));
  };

  return [
    ...collect("dependencies", false),
    ...collect("devDependencies", true),
  ];
}

/** requirements.txt is a line per requirement, with `#` comments.
 *
 *  Only the simple forms are listed: `name`, `name==1.2`, `name>=1,<2`. A line
 *  naming a URL, an editable install or another requirements file is skipped
 *  rather than mangled — it stays in the file untouched, it is just not
 *  something this panel offers to remove. */
export function parseRequirements(raw: string): PackageEntry[] {
  const entries: PackageEntry[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const withoutComment = line.split("#")[0]?.trim() ?? "";
    if (withoutComment.length === 0) continue;
    if (withoutComment.startsWith("-")) continue;
    if (/[:@]/.test(withoutComment)) continue;

    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(.*)$/.exec(withoutComment);
    if (!match?.[1]) continue;

    entries.push({ name: match[1], version: (match[2] ?? "").trim() });
  }

  return entries;
}

/** go.mod: a `require` block, or single `require` lines. */
export function parseGoMod(raw: string): PackageEntry[] {
  const entries: PackageEntry[] = [];
  let inBlock = false;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.split("//")[0]?.trim() ?? "";
    if (trimmed.length === 0) continue;

    if (inBlock) {
      if (trimmed === ")") {
        inBlock = false;
        continue;
      }
      const [name, version] = trimmed.split(/\s+/);
      if (name && version) entries.push({ name, version });
      continue;
    }

    if (trimmed === "require (") {
      inBlock = true;
      continue;
    }

    const single = /^require\s+(\S+)\s+(\S+)$/.exec(trimmed);
    if (single?.[1] && single[2]) {
      entries.push({ name: single[1], version: single[2] });
    }
  }

  return entries;
}

const PARSERS = {
  npm: parsePackageJson,
  pip: parseRequirements,
  go: parseGoMod,
} as const satisfies Record<Ecosystem, (raw: string) => PackageEntry[]>;

/** Reads a manifest from the working tree on the host.
 *
 *  Deliberately not through the container: the tree is bind-mounted, so the
 *  host sees the same bytes, and opening the packages panel should not start a
 *  container for a project that is only being looked at. */
async function readManifest(
  projectId: string,
  file: string,
): Promise<string | null> {
  try {
    return await readFile(resolveInProject(projectId, file), "utf8");
  } catch {
    return null;
  }
}

export async function listPackages(projectId: string): Promise<PackageList> {
  assertValidProjectId(projectId);

  for (const ecosystem of DETECTION_ORDER) {
    const manifest = MANIFEST_BY_ECOSYSTEM[ecosystem];
    const raw = await readManifest(projectId, manifest);
    if (raw === null) continue;

    return {
      ecosystem,
      manifest,
      packages: PARSERS[ecosystem](raw),
    };
  }

  return { ecosystem: null, manifest: null, packages: [] };
}

/** The ecosystem a mutation is about to act on, refusing early when there is
 *  none — otherwise `npm install` would run in a project that has no
 *  package.json and create one, which is not what "add a dependency" meant. */
async function requireEcosystem(projectId: string): Promise<Ecosystem> {
  const { ecosystem } = await listPackages(projectId);

  if (!ecosystem) {
    throw new BadRequestError(
      "This project has no dependency manifest, so there is nothing to add to. " +
        "Create a package.json, requirements.txt or go.mod first.",
      "NO_ECOSYSTEM",
    );
  }

  return ecosystem;
}

/* ---- writing ---- */

export interface PackageCommandResult {
  /** Combined stdout and stderr, so a failed install can be read in the panel
   *  rather than only in the terminal. */
  output: string;
  packages: PackageList;
}

/** Runs a package manager in the project's container and re-reads the manifest.
 *
 *  The tool edits the manifest, never this code: `npm install` knows how to
 *  write a range, and hand-editing JSON around it would fight whatever the user
 *  has done in the file themselves. */
async function run(
  projectId: string,
  argv: string[],
): Promise<PackageCommandResult> {
  const container = await ensureContainer(assertValidProjectId(projectId));
  const { stdout, stderr, exitCode } = await execCapture(container, argv, {
    workingDir: APP_DIR,
  });

  const output = [stdout, stderr].filter((part) => part.trim()).join("\n").trim();

  if (exitCode !== 0) {
    // The manager's own last line says more than "it failed" ever could.
    const reason =
      output.split("\n").filter(Boolean).slice(-1)[0] ?? "the command failed";
    throw new BadRequestError(reason, "PACKAGE_COMMAND_FAILED");
  }

  return { output, packages: await listPackages(projectId) };
}

/** argv for adding, per ecosystem. `version` may be empty for "latest". */
export function addArgv(
  ecosystem: Ecosystem,
  name: string,
  version: string,
  dev: boolean,
): string[] {
  if (ecosystem === "npm") {
    return [
      "npm",
      "install",
      ...(dev ? ["--save-dev"] : []),
      version ? `${name}@${version}` : name,
    ];
  }

  if (ecosystem === "pip") {
    // `--no-input` so a prompt cannot hang the exec forever; there is no
    // terminal attached to answer one.
    return ["pip", "install", "--no-input", version ? `${name}${version}` : name];
  }

  // `@latest` is explicit rather than implied: a bare `go get name` resolves
  // differently depending on the go version.
  return ["go", "get", `${name}@${version || "latest"}`];
}

export function removeArgv(ecosystem: Ecosystem, name: string): string[] {
  if (ecosystem === "npm") return ["npm", "uninstall", name];
  if (ecosystem === "pip") return ["pip", "uninstall", "--yes", name];
  // Go has no uninstall; dropping the requirement is how a module is removed.
  return ["go", "get", `${name}@none`];
}

export async function addPackage(
  projectId: string,
  rawName: string,
  rawVersion: string,
  dev: boolean,
): Promise<PackageCommandResult> {
  const ecosystem = await requireEcosystem(projectId);
  const name = assertValidName(ecosystem, rawName);
  const version = assertValidVersion(rawVersion);

  const result = await run(projectId, addArgv(ecosystem, name, version, dev));

  // pip installs into the environment and leaves requirements.txt alone, so
  // the manifest — which is what the panel lists and what a rebuild reads —
  // would not mention the package that was just added.
  if (ecosystem === "pip") {
    await rewriteRequirements(projectId, name, version);
    return { ...result, packages: await listPackages(projectId) };
  }

  return result;
}

export async function removePackage(
  projectId: string,
  rawName: string,
): Promise<PackageCommandResult> {
  const ecosystem = await requireEcosystem(projectId);
  const name = assertValidName(ecosystem, rawName);

  const result = await run(projectId, removeArgv(ecosystem, name));

  if (ecosystem === "pip") {
    await rewriteRequirements(projectId, name, null);
    return { ...result, packages: await listPackages(projectId) };
  }

  return result;
}

/* ---- requirements.txt ---- */

/** Adds, updates or drops one requirement, leaving every other line alone.
 *
 *  pip is the one manager here that will not maintain its own manifest, so
 *  this is the only place the file is edited by hand. Lines it does not
 *  understand — URLs, `-e`, `-r` includes, comments, blanks — are copied
 *  through untouched rather than being normalised away, because a requirements
 *  file is frequently hand-written and its comments are load-bearing.
 *
 *  Exported for the tests: the editing rules are the part worth pinning.
 */
export function editRequirements(
  raw: string,
  name: string,
  version: string | null,
): string {
  const wanted = name.toLowerCase();
  // pip treats "-" and "_" as the same character in a distribution name.
  const same = (candidate: string) =>
    candidate.toLowerCase().replace(/_/g, "-") === wanted.replace(/_/g, "-");

  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  let replaced = false;

  for (const line of lines) {
    const withoutComment = line.split("#")[0]?.trim() ?? "";
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(withoutComment);

    if (!match?.[1] || !same(match[1])) {
      kept.push(line);
      continue;
    }

    if (version === null) continue;
    kept.push(version ? `${name}${version}` : name);
    replaced = true;
  }

  // Trailing blanks go in every case, not only when appending: splitting on
  // newline turns the newline a file ends with into an empty final element, so
  // re-joining would add one more line every time the file was edited.
  while (kept.length > 0 && (kept[kept.length - 1] ?? "").trim() === "") {
    kept.pop();
  }

  if (version !== null && !replaced) {
    kept.push(version ? `${name}${version}` : name);
  }

  return kept.length === 0 ? "" : kept.join("\n") + "\n";
}

async function rewriteRequirements(
  projectId: string,
  name: string,
  version: string | null,
): Promise<void> {
  const file = MANIFEST_BY_ECOSYSTEM.pip;
  const raw = (await readManifest(projectId, file)) ?? "";
  const next = editRequirements(raw, name, version);

  const { writeFile } = await import("node:fs/promises");
  await writeFile(resolveInProject(projectId, file), next, "utf8");
}
