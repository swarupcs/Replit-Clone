import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Container } from "dockerode";
import { projectRoot } from "../utils/projectPaths.js";
import { execCapture } from "./execCapture.js";
import { logger } from "../lib/logger.js";

/** Skipping an install that would have changed nothing.
 *
 *  Every template's start command begins with its install step — `npm install
 *  && npm run dev`, `pip install -r requirements.txt && python app.py` — so
 *  opening a project pays for a full dependency resolution before the dev
 *  server is even asked to boot. That is correct the first time and a waste
 *  every time after it: `node_modules` lives in the bind mount and survives the
 *  container being stopped, and the container's own writable layer survives it
 *  too, so by the second start the work has usually already been done.
 *
 *  The install is skipped only when a fingerprint of everything that decides
 *  its outcome is byte-for-byte what it was after the last install that
 *  succeeded. Anything unaccounted for — a manifest edited by hand, a lockfile
 *  updated, a dependency added through the packages panel, a container rebuilt
 *  — moves the fingerprint and the install runs. The failure direction is
 *  therefore always "install again unnecessarily", never "serve against
 *  dependencies that are not there".
 */

/** Where the last successful install's fingerprint is kept.
 *
 *  Inside the container and deliberately OUTSIDE the bind mount at
 *  /home/sandbox/app: it is machinery, not the user's file, and it must not
 *  appear in their file tree, their git status or their export.
 *
 *  Living in the writable layer also gives it exactly the right lifetime. It
 *  survives a stop and start, which is the case this feature exists for, and it
 *  is lost when the container is rebuilt — which is also when a pip install's
 *  site-packages is lost, so the two go together rather than the stamp
 *  outliving what it vouches for.
 */
export const STAMP_PATH = "/home/sandbox/.rc-install-stamp";

/** Files whose contents decide what an install produces.
 *
 *  Lockfiles included, because a lockfile changing is the ordinary way a
 *  dependency moves without the manifest being touched at all. Read from the
 *  host — the tree is bind-mounted, so these are the same bytes the container
 *  sees, without an exec.
 */
export const DEPENDENCY_FILES = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "requirements.txt",
  "go.mod",
  "go.sum",
];

/** Command prefixes that only install, and can therefore be skipped.
 *
 *  An allowlist rather than a pattern: this decides whether to NOT run half of
 *  a command, and being wrong means serving an app whose dependencies were
 *  never installed. Anything not listed here is left alone and runs in full.
 */
const INSTALL_PREFIXES = [
  "npm install",
  "npm ci",
  "npm i ",
  "yarn install",
  "yarn --frozen-lockfile",
  "pnpm install",
  "pnpm i ",
  "pip install",
  "pip3 install",
  "python -m pip install",
];

export interface SplitCommand {
  /** The install half, without the `&&`. */
  install: string;
  /** Everything after it, run whether or not the install is skipped. */
  serve: string;
}

/** Splits `<install> && <rest>` when — and only when — the left half is an
 *  install and nothing else.
 *
 *  Returns null for a command this cannot take apart with certainty, including
 *  every command a user wrote themselves: a project may carry its own run
 *  command, and guessing at the shape of one is how a start silently stops
 *  installing. Null means "run it exactly as written".
 */
export function splitStartCommand(command: string): SplitCommand | null {
  const trimmed = command.trim();

  const at = trimmed.indexOf("&&");
  if (at <= 0) return null;

  const install = trimmed.slice(0, at).trim();
  const serve = trimmed.slice(at + 2).trim();

  if (install.length === 0 || serve.length === 0) return null;

  // A second `&&` on the left would mean the first half is not one command,
  // and this only understands one.
  if (install.includes("&&") || install.includes("||") || install.includes(";")) {
    return null;
  }

  const lower = install.toLowerCase();
  const isInstall = INSTALL_PREFIXES.some(
    (prefix) => lower === prefix.trim() || lower.startsWith(prefix),
  );

  return isInstall ? { install, serve } : null;
}

/** A hash of everything that decides the install's outcome, or null when the
 *  project declares no dependencies at all.
 *
 *  The file's NAME is hashed alongside its contents, so deleting
 *  `package-lock.json` moves the fingerprint rather than leaving it looking
 *  identical to a project that never had one.
 */
export async function dependencyFingerprint(
  projectId: string,
): Promise<string | null> {
  const root = projectRoot(projectId);
  const hash = createHash("sha256");
  let found = false;

  for (const file of DEPENDENCY_FILES) {
    const contents = await readFile(path.join(root, file)).catch(() => null);
    if (contents === null) continue;

    found = true;
    hash.update(file);
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }

  return found ? hash.digest("hex") : null;
}

export interface WarmStartDecision {
  /** The command to actually run. */
  command: string;
  /** True when the install half was left out. */
  skippedInstall: boolean;
  /** The fingerprint to stamp once this run proves itself, or null when there
   *  is nothing worth stamping. */
  fingerprint: string | null;
}

/** Decides what to run, given the command, the current fingerprint and the one
 *  stamped by the last install that succeeded.
 *
 *  Pure, because this is the part worth testing: every input that could make it
 *  wrongly skip is an argument here rather than a file read inside it.
 */
export function planStart(options: {
  command: string;
  fingerprint: string | null;
  stamped: string | null;
  /** Whether the artefacts the last install produced are still present. False
   *  forces a full run however well the fingerprint matches — a user who
   *  deleted `node_modules` did so meaning it. */
  installed: boolean;
}): WarmStartDecision {
  const { command, fingerprint, stamped, installed } = options;
  const split = splitStartCommand(command);

  // Nothing to skip, or nothing to compare against.
  if (!split || fingerprint === null) {
    return { command, skippedInstall: false, fingerprint };
  }

  if (installed && stamped !== null && stamped === fingerprint) {
    return { command: split.serve, skippedInstall: true, fingerprint };
  }

  return { command, skippedInstall: false, fingerprint };
}

/* ---- the container side ---- */

/** Longest either stamp exec may take before it is abandoned.
 *
 *  These sit directly in the path of starting a project, so a daemon that is
 *  slow or an exec that never closes its stream must not be able to hold a
 *  start open. Giving up answers "no stamp", which installs — the safe
 *  direction, and no slower than the behaviour this replaced.
 */
const STAMP_TIMEOUT_MS = 2_000;

function withTimeout<T>(work: Promise<T>, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      resolve(fallback);
    }, STAMP_TIMEOUT_MS);
    // Nothing here should keep the process alive on its own.
    timer.unref?.();

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** The fingerprint stamped by the last install that succeeded, or null.
 *
 *  Every failure answers null, which means "install", so a container that
 *  cannot be read from installs rather than serving on a guess.
 */
export function readStamp(container: Container): Promise<string | null> {
  const read = execCapture(container, ["cat", STAMP_PATH]).then(
    ({ stdout, exitCode }) => {
      if (exitCode !== 0) return null;

      const value = stdout.trim();
      // Shape-checked: anything else is a file this did not write, and taking
      // it at face value would compare a fingerprint against nonsense.
      return /^[0-9a-f]{64}$/.test(value) ? value : null;
    },
  );

  return withTimeout(read, null);
}

/** Records a fingerprint as installed.
 *
 *  Best-effort: failing to write it costs one unnecessary install next time,
 *  which is the direction this is allowed to be wrong in.
 */
export async function writeStamp(
  container: Container,
  fingerprint: string,
): Promise<void> {
  // The value is a hex digest this module produced, so there is nothing in it
  // for the shell to read -- but it is passed as an ARGUMENT rather than
  // interpolated into the command, so a future caller cannot make it one.
  const write = execCapture(container, [
    "sh",
    "-c",
    `printf %s "$1" > ${STAMP_PATH}`,
    "sh",
    fingerprint,
  ]).then(() => true);

  const written = await withTimeout(write, false);
  if (!written) logger.info("could not stamp the install", { path: STAMP_PATH });
}

/** Clears the stamp, so the next start installs.
 *
 *  Used when an install is known to have been undone -- today only by the run
 *  itself failing, which must not leave a stamp claiming otherwise.
 */
export async function clearStamp(container: Container): Promise<void> {
  await execCapture(container, ["rm", "-f", STAMP_PATH]).catch(() => undefined);
}

/** Whether the artefacts a previous install produced are still there.
 *
 *  `node_modules` is checked on the host because it lives in the bind mount,
 *  where the user can delete it -- and deleting it has to mean what they
 *  intended, however well the stamp matches.
 *
 *  A pip install goes into the container's own writable layer instead, which
 *  the user cannot reach from the file tree and which has exactly the same
 *  lifetime as the stamp: both are lost together when the container is rebuilt.
 *  There is therefore nothing separate to check, and the stamp existing is the
 *  whole answer.
 */
export async function installArtefactsPresent(
  projectId: string,
): Promise<boolean> {
  const hasPackageJson = await stat(
    path.join(projectRoot(projectId), "package.json"),
  )
    .then(() => true)
    .catch(() => false);

  if (!hasPackageJson) return true;

  return stat(path.join(projectRoot(projectId), "node_modules"))
    .then((entry) => entry.isDirectory())
    .catch(() => false);
}
