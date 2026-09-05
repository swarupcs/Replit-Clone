import type { Container } from "dockerode";
import { execCapture } from "./execCapture.js";
import { logger } from "../lib/logger.js";

/** Making a container come up as *your* shell.
 *
 *  plan.md §11.9. Every container has always started with a stock `/bin/bash`
 *  -- no aliases, no prompt, no `.vimrc`, no `.gitconfig` beyond the two `-c`
 *  flags `commit` passes. The devcontainer ecosystem's answer to that is a
 *  personal dotfiles repository cloned into every workspace, and at n=1 "it
 *  comes up as my shell" is a large fraction of what "personal" means.
 *
 *  Three settings, and deliberately the same three VS Code exposes -- a
 *  repository, where it lands, and what to run afterwards -- so a dotfiles
 *  repository that works there works here without being rewritten.
 */

/** Where the project's own files live. Nothing here may touch it: see
 *  `resolveTarget`. */
const APP_DIR = "/home/sandbox/app";
const HOME = "/home/sandbox";

/** The default landing place, and the one every dotfiles README assumes. */
const DEFAULT_TARGET = `${HOME}/dotfiles`;

/** Scripts looked for when no install command was given, in order.
 *
 *  These three names cover most of what is on GitHub. The fallback linker
 *  below covers the rest.
 */
const CONVENTIONAL_INSTALLERS = ["install.sh", "setup.sh", "bootstrap.sh"];

export interface DotfilesSettings {
  repo: string;
  target?: string | null;
  install?: string | null;
}

/** Rejects a repository URL this server will not clone.
 *
 *  Three refusals, each for its own reason:
 *
 *  - **https only.** `ssh://` and `git@host:path` would authenticate as the
 *    SERVER, using whatever key the host happens to have, which is not the
 *    user's identity and may be a deployment key with real access. `file://`
 *    would clone out of the server's own filesystem.
 *  - **no credentials in the URL.** `https://user:token@host/...` is a
 *    password, and it would sit in a column in the clear next to a comment
 *    saying this table holds nothing secret.
 *  - **nothing starting with a dash**, which git might read as an option.
 *    Belt to the braces of passing argv as an array.
 *
 *  A private repository therefore FAILS rather than working, and that is the
 *  intended outcome: the alternative is handing the user's GitHub token to a
 *  clone that runs inside a container full of somebody's dependencies.
 */
export function validateRepoUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("A dotfiles repository needs a URL.");
  if (value.length > 500) throw new Error("That URL is implausibly long.");
  if (value.startsWith("-")) throw new Error("That is not a URL.");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Use a full https:// URL, for example https://github.com/you/dotfiles.",
    );
  }

  if (url.protocol !== "https:") {
    throw new Error(
      "Only https:// repositories can be cloned. An ssh:// URL would " +
        "authenticate as the server rather than as you.",
    );
  }

  if (url.username || url.password) {
    throw new Error(
      "Leave credentials out of the URL. A private dotfiles repository is " +
        "not supported: nothing here sends a token with the clone.",
    );
  }

  return url.toString();
}

/** Rejects a target path that would put dotfiles somewhere they would do harm.
 *
 *  The one that matters is `/home/sandbox/app`: that is the bind mount, so a
 *  clone into it lands in the user's PROJECT -- on the host disk, inside their
 *  repository, and against their disk quota. Somebody would find it later as
 *  an unexplained `dotfiles/` directory in a commit.
 *
 *  Everything else follows from wanting the path to be somewhere the
 *  container's own user can write without the platform deciding it may.
 */
export function resolveTarget(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_TARGET;

  // `~/` is what a person types, and what VS Code's own setting accepts.
  //
  // Trailing slashes come off HERE rather than on the way out, because the
  // checks below compare against exact paths: `~/` expands to "/home/sandbox/",
  // which is not equal to HOME and does start with "HOME/", so it slipped past
  // the refusal of the home directory and was only trimmed afterwards. A test
  // found it.
  const expanded = (
    value.startsWith("~/") ? `${HOME}/${value.slice(2)}` : value
  ).replace(/\/+$/, "");

  if (!expanded.startsWith("/")) {
    throw new Error("Use an absolute path, or one starting with ~/.");
  }
  // No traversal, so there is no way to spell the app directory sideways.
  if (expanded.split("/").includes("..")) {
    throw new Error("A target path may not contain '..'.");
  }
  if (expanded !== HOME && !expanded.startsWith(`${HOME}/`)) {
    throw new Error(`Dotfiles have to land under ${HOME}.`);
  }
  if (expanded === APP_DIR || expanded.startsWith(`${APP_DIR}/`)) {
    throw new Error(
      `${APP_DIR} is the project itself. Dotfiles cloned there would end up ` +
        "committed to your repository.",
    );
  }
  if (expanded === HOME) {
    throw new Error(
      "Clone into a directory of its own, not straight into the home " +
        "directory -- the install step is what puts files in ~.",
    );
  }

  return expanded;
}

/** Single-quotes a string for `sh -c`.
 *
 *  The only quoting that is safe for arbitrary text: inside single quotes
 *  nothing is special, and a single quote is closed, escaped and reopened.
 */
export function shellQuote(value: string): string {
  return "'" + value.split("'").join(`'\\''`) + "'";
}

/** The shell script run inside the container.
 *
 *  One script rather than four execs, because the steps are conditional on
 *  each other and each exec is a round trip -- and because the whole thing has
 *  to be re-runnable: a container is recreated whenever its environment
 *  signature changes, which is often.
 *
 *  `GIT_TERMINAL_PROMPT=0` is the load-bearing line. Without it a private or
 *  misspelled repository makes git sit waiting for a username nobody can type,
 *  and the clone hangs until the deadline instead of failing in a second with
 *  a message.
 *
 *  The fallback linker is what makes this work for the repositories that ship
 *  no installer, which is most of them: symlink the top-level dotfiles into
 *  the home directory, skip `.git` itself, and never overwrite a real file
 *  that is already there.
 */
export function dotfilesScript(target: string, install: string | null): string {
  // A plain if/elif chain rather than a shell function, because `set -e` is
  // suspended inside an `if` condition: a function called as a condition
  // whose installer FAILED would return non-zero, read as "no installer
  // found", and fall through to the linker as though nothing were wrong.
  const conventional = CONVENTIONAL_INSTALLERS.map(
    (name, index) =>
      `${index === 0 ? "if" : "elif"} [ -x "${name}" ]; then ./${name}`,
  ).join("\n");

  const fallback = [
    conventional,
    "else",
    `  for f in .[!.]*; do`,
    `    [ -e "$f" ] || continue`,
    `    case "$f" in .git|.github) continue;; esac`,
    // A real file already at that name is the user's, not ours. A symlink is
    // one of ours from a previous run and is replaced.
    `    if [ -e "$HOME/$f" ] && [ ! -L "$HOME/$f" ]; then continue; fi`,
    `    ln -sfn "${target}/$f" "$HOME/$f"`,
    "  done",
    "fi",
  ].join("\n");

  return [
    "set -e",
    "export GIT_TERMINAL_PROMPT=0",
    // Re-runnable: a container recreated for an unrelated reason must not fail
    // on "directory exists", and must not keep a stale clone either.
    `rm -rf "${target}"`,
    `mkdir -p "$(dirname "${target}")"`,
    // Depth 1: nobody needs their dotfiles' history inside a sandbox, and this
    // clone sits directly in the path of opening a project.
    `git clone --depth 1 -- "$RC_DOTFILES_REPO" "${target}"`,
    `cd "${target}"`,
    // Through `sh -c` because it is a command line the user typed, running in
    // the user's own container. The same trust level as the terminal.
    install ? `sh -c ${shellQuote(install)}` : fallback,
  ].join("\n");
}

export interface DotfilesResult {
  ok: boolean;
  log: string;
}

/** Clones and installs one account's dotfiles into one container.
 *
 *  Best-effort, exactly as `runLifecycle` is and for the same reason: this is
 *  arbitrary code out of a repository the platform does not control, and a
 *  broken one must leave the user with a working container and a readable
 *  reason rather than a project that will not open.
 *
 *  The URL goes in through the ENVIRONMENT rather than argv. It is not secret,
 *  but `execCapture`'s own note is right about why the habit is worth keeping:
 *  argv is world-readable through /proc, and the next thing somebody passes
 *  through here will be.
 */
export async function applyDotfiles(
  container: Container,
  settings: DotfilesSettings,
  timeoutMs: number,
): Promise<DotfilesResult> {
  let repo: string;
  let target: string;
  try {
    repo = validateRepoUrl(settings.repo);
    target = resolveTarget(settings.target);
  } catch (error) {
    // Stored settings can be older than the rules that validate them, so this
    // is reachable even though the API refuses the same values on the way in.
    return { ok: false, log: (error as Error).message };
  }

  const script = dotfilesScript(target, settings.install?.trim() ?? null);

  const result = await withTimeout(
    execCapture(container, ["sh", "-c", script], {
      workingDir: HOME,
      env: { RC_DOTFILES_REPO: repo },
    }),
    timeoutMs,
  );

  if (!result) {
    return {
      ok: false,
      log: `Dotfiles gave up after ${String(Math.round(timeoutMs / 1000))}s.`,
    };
  }

  const log = [result.stdout, result.stderr]
    .filter((part) => part.trim())
    .join("\n")
    .trim();

  if (result.exitCode !== 0) {
    logger.warn("dotfiles failed", { exitCode: result.exitCode });
    return {
      ok: false,
      log: log || `Dotfiles exited ${String(result.exitCode)}.`,
    };
  }

  return { ok: true, log };
}

/** Resolves to undefined when the work outlives its budget.
 *
 *  A copy of `containerManager`'s `withDeadline` rather than an import, to keep
 *  this module free of that one -- containerManager imports THIS. The exec
 *  keeps running inside the container; what stops is the waiting.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}
