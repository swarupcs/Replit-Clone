import type {
  GitBranch,
  GitRemote,
  GitChange,
  GitChangeState,
  GitCommit,
  GitStatus,
} from "@replit-clone/shared";
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { ensureContainer } from "../containers/containerManager.js";
import { execCapture } from "../containers/execCapture.js";
import { BadRequestError } from "../utils/errors.js";
import { assertValidProjectId, projectRoot } from "../utils/projectPaths.js";

const APP_DIR = "/home/sandbox/app";

/** The shapes below are declared once, in the shared package, so the web app
 *  and this service cannot drift apart on what a change looks like. */
export type {
  GitBranch,
  GitRemote,
  GitChange,
  GitCommit,
  GitStatus,
} from "@replit-clone/shared";
export type ChangeState = GitChangeState;

/** Maps one half of a porcelain status code to a state.
 *
 *  The two columns mean different things -- the first is index-versus-HEAD, the
 *  second is worktree-versus-index -- but the letters are shared. */
function toState(code: string): GitChangeState | undefined {
  switch (code) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "?":
      return "untracked";
    default:
      return undefined;
  }
}

/** Parses `git status --porcelain=v1 -b -z`.
 *
 *  `-z` matters: without it git quotes any path containing a space, a quote or
 *  a non-ASCII byte, and that quoting is C-style rather than anything a naive
 *  split can undo. With it, every path is literal and NUL-terminated.
 *
 *  Exported for its own sake -- the parsing is the part worth testing, and it
 *  needs no Docker to exercise.
 */
export function parseStatus(raw: string): Omit<GitStatus, "isRepo"> {
  // A trailing NUL would otherwise produce a final empty entry.
  const entries = raw.split("\0").filter((entry) => entry.length > 0);
  const result: Omit<GitStatus, "isRepo"> = { changes: [] };

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) continue;

    if (entry.startsWith("## ")) {
      const header = entry.slice(3);

      if (header.startsWith("No commits yet on ")) {
        result.unborn = true;
        result.branch = header.slice("No commits yet on ".length).trim();
        continue;
      }

      // "main...origin/main [ahead 1, behind 2]"
      const branch = header.split("...")[0]?.split(" ")[0];
      if (branch && branch !== "HEAD") result.branch = branch;

      const ahead = /ahead (\d+)/.exec(header);
      const behind = /behind (\d+)/.exec(header);
      if (ahead?.[1]) result.ahead = Number(ahead[1]);
      if (behind?.[1]) result.behind = Number(behind[1]);
      continue;
    }

    // "XY path", where XY is exactly two columns and one space follows.
    const x = entry[0] ?? " ";
    const y = entry[1] ?? " ";
    const path = entry.slice(3);
    if (!path) continue;

    const change: GitChange = { path };

    if (x === "?" && y === "?") {
      change.unstaged = "untracked";
    } else {
      const staged = toState(x);
      const unstaged = toState(y);
      if (staged) change.staged = staged;
      if (unstaged) change.unstaged = unstaged;

      // A rename spends two entries: the new path, then the old one.
      if (x === "R" || y === "R") {
        const previous = entries[i + 1];
        if (previous) {
          change.from = previous;
          i += 1;
        }
      }
    }

    result.changes.push(change);
  }

  return result;
}

/** Parses the `git log` format pinned in `history` below. */
export function parseLog(raw: string): GitCommit[] {
  return raw
    .split("\0")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [hash = "", shortHash = "", author = "", date = "", ...rest] =
        line.split("\x1f");
      // The subject is taken last so that one containing the separator cannot
      // shift the fields before it.
      return { hash, shortHash, author, date, subject: rest.join("\x1f") };
    });
}

async function git(
  projectId: string,
  argv: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const container = await ensureContainer(assertValidProjectId(projectId));
  return execCapture(container, ["git", ...argv], {
    workingDir: APP_DIR,
    ...(env ? { env } : {}),
  });
}

/** Runs a git command that is expected to succeed, and turns a non-zero exit
 *  into an error carrying git's own message rather than a silent no-op. */
async function gitOrThrow(projectId: string, argv: string[]): Promise<string> {
  const { stdout, stderr, exitCode } = await git(projectId, argv);
  if (exitCode !== 0) {
    const message = (stderr || stdout).trim().split("\n")[0] ?? "git failed";
    throw new BadRequestError(message, "GIT_FAILED");
  }
  return stdout;
}

export async function isRepo(projectId: string): Promise<boolean> {
  const { stdout, exitCode } = await git(projectId, [
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  return exitCode === 0 && stdout.trim() === "true";
}

export async function status(projectId: string): Promise<GitStatus> {
  if (!(await isRepo(projectId))) return { isRepo: false, changes: [] };

  const stdout = await gitOrThrow(projectId, [
    "status",
    "--porcelain=v1",
    "-b",
    "-z",
    "--untracked-files=all",
  ]);

  return { isRepo: true, ...parseStatus(stdout) };
}

export async function init(projectId: string): Promise<GitStatus> {
  if (await isRepo(projectId)) return status(projectId);
  // -b so the default branch does not depend on the image's git version.
  await gitOrThrow(projectId, ["init", "-b", "main"]);
  return status(projectId);
}

export async function diff(
  projectId: string,
  path: string,
  staged: boolean,
): Promise<string> {
  const argv = ["diff", "--no-color"];
  if (staged) argv.push("--staged");
  // `--` stops a path that looks like a flag, or like a branch name, from
  // being read as one.
  argv.push("--", path);

  const { stdout } = await git(projectId, argv);

  // An untracked file has nothing to diff against, so git says nothing at all.
  if (!stdout.trim() && !staged) {
    const untracked = await git(projectId, [
      "diff",
      "--no-color",
      "--no-index",
      "/dev/null",
      path,
    ]);
    // --no-index exits 1 whenever the files differ, which is the normal case
    // here, so its exit code is deliberately not checked.
    return untracked.stdout;
  }

  return stdout;
}

export async function stage(projectId: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await gitOrThrow(projectId, ["add", "--", ...paths]);
}

export async function unstage(
  projectId: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  // `reset` rather than `restore --staged`, which needs a HEAD to restore from
  // and so fails on a repository with no commits yet.
  const { stderr, exitCode } = await git(projectId, ["reset", "--", ...paths]);
  if (exitCode !== 0 && stderr.trim()) {
    throw new BadRequestError(
      stderr.trim().split("\n")[0] ?? "git failed",
      "GIT_FAILED",
    );
  }
}

/** The script that makes a SIGNED commit. plan.md §11.9.
 *
 *  A shell script rather than an argv, and only because git's SSH signing
 *  backend needs the private key as a FILE -- there is no way to hand it one
 *  on a pipe. So: a private temporary directory, the key written into it with
 *  `umask 077`, the commit, and a `trap` that removes it whether the commit
 *  worked or not. `mktemp -d` lands in /tmp, which is deliberately NOT the
 *  bind mount: a key written under /home/sandbox/app would appear in the
 *  user's project, on the host disk, and in `git status`.
 *
 *  Nothing is interpolated into this script. The key, the public half, the
 *  author and the message all arrive as environment variables, so a commit
 *  message containing a quote, a newline or a `$(...)` is text rather than a
 *  command -- and, per `execCapture`'s own note, the key is out of argv and so
 *  out of /proc for every process not owned by this container's user.
 *
 *  The `.pub` beside the private key is not optional: that is where
 *  `ssh-keygen -Y sign` looks for the public half rather than deriving it.
 */
export function signedCommitScript(): string {
  return [
    "set -e",
    // Before anything is written, not after: a chmod after the fact leaves a
    // window in which the key is world-readable.
    "umask 077",
    "d=$(mktemp -d)",
    `trap 'rm -rf "$d"' EXIT INT TERM`,
    // `printf '%s\n'` rather than `echo`, whose handling of a value beginning
    // with a dash is not portable -- and a private key ends in a newline that
    // ssh-keygen insists on.
    `printf '%s\\n' "$RC_SIGNING_KEY" > "$d/key"`,
    `printf '%s\\n' "$RC_SIGNING_PUB" > "$d/key.pub"`,
    // -c rather than `git config`, so signing never writes to the repository's
    // own config on the user's behalf -- the same rule the author already
    // followed, and it matters more here: a `user.signingkey` left behind
    // would point at a directory that no longer exists.
    "git" +
      ' -c user.name="$RC_NAME"' +
      ' -c user.email="$RC_EMAIL"' +
      " -c gpg.format=ssh" +
      ' -c user.signingkey="$d/key"' +
      ' commit -S -m "$RC_MESSAGE"',
  ].join("\n");
}

/** Runs `signedCommitScript` with everything it needs in the environment. */
async function signedCommit(
  projectId: string,
  message: string,
  author: { name: string; email: string },
  signing: { privateKey: string; publicKey: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const container = await ensureContainer(assertValidProjectId(projectId));

  return execCapture(container, ["sh", "-c", signedCommitScript()], {
    workingDir: APP_DIR,
    env: {
      RC_SIGNING_KEY: signing.privateKey,
      RC_SIGNING_PUB: signing.publicKey,
      RC_NAME: author.name,
      RC_EMAIL: author.email,
      RC_MESSAGE: message,
    },
  });
}

export async function commit(
  projectId: string,
  message: string,
  author: { name: string; email: string },
  signing?: { privateKey: string; publicKey: string } | null,
): Promise<GitCommit[]> {
  const trimmed = message.trim();
  if (!trimmed) throw new BadRequestError("A commit needs a message");

  const { stdout, stderr, exitCode } = signing
    ? await signedCommit(projectId, trimmed, author, signing)
    : await git(projectId, [
        // -c rather than `git config`, so committing never writes to the repo's
        // own config on the user's behalf.
        "-c",
        `user.name=${author.name}`,
        "-c",
        `user.email=${author.email}`,
        "commit",
        "-m",
        trimmed,
      ]);

  if (exitCode !== 0) {
    const combined = `${stdout}\n${stderr}`;
    if (/nothing to commit|no changes added/i.test(combined)) {
      throw new BadRequestError("Nothing staged to commit", "NOTHING_STAGED");
    }
    // Only in the signing branch, and matching several phrasings, because git
    // does not have one. With a bad key it says "gpg failed to sign the data",
    // naming a tool that is not involved; with `ssh-keygen` missing from the
    // image it says "cannot run ssh-keygen" and then "failed to write commit
    // object", naming a symptom two steps downstream. Both were seen in a real
    // container. Either way the commit is unmade and the work is still staged,
    // which is the part the person needs told.
    if (
      signing &&
      /failed to sign|cannot run ssh-keygen|failed to write commit object/i.test(
        combined,
      )
    ) {
      throw new BadRequestError(
        "The commit was not made because it could not be signed. Nothing was " +
          "lost — your changes are still staged. Check the signing key on " +
          "your account, or turn signing off to commit without it.",
        "SIGNING_FAILED",
      );
    }
    throw new BadRequestError(
      stderr.trim().split("\n")[0] ?? "Commit failed",
      "GIT_FAILED",
    );
  }

  return history(projectId, 20);
}

export async function history(
  projectId: string,
  limit = 20,
): Promise<GitCommit[]> {
  if (!(await isRepo(projectId))) return [];

  const { stdout, exitCode } = await git(projectId, [
    "log",
    `--max-count=${String(limit)}`,
    // Unit separators between fields, NUL between records: neither can occur
    // in a name, a date or a subject line.
    "--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x00",
  ]);

  // An unborn branch has no commits and `log` exits non-zero saying so.
  if (exitCode !== 0) return [];

  return parseLog(stdout);
}

/** Parses `git branch --format=%(refname:short)%00%(HEAD)`.
 *
 *  NUL between the name and the marker, because a branch name may contain
 *  almost anything git's ref rules allow -- including spaces -- and splitting
 *  on one would corrupt those names.
 *
 *  A detached HEAD is skipped: git lists it as "(HEAD detached at abc1234)",
 *  which is a state rather than a branch and cannot be switched to by name.
 */
export function parseBranches(raw: string): GitBranch[] {
  const branches: GitBranch[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    const [name = "", marker = ""] = line.split("\0");
    if (!name || name.startsWith("(")) continue;

    branches.push({ name, current: marker.trim() === "*" });
  }

  return branches;
}

/** Every local branch, current one marked. */
export async function branches(projectId: string): Promise<GitBranch[]> {
  if (!(await isRepo(projectId))) return [];

  const { stdout, exitCode } = await git(projectId, [
    "branch",
    "--format=%(refname:short)%00%(HEAD)",
  ]);

  // An unborn branch has no refs yet, so `branch` lists nothing.
  if (exitCode !== 0) return [];

  return parseBranches(stdout);
}

/** Rejects a name git would refuse, or that would be read as a flag.
 *
 *  `git check-ref-format` is the authority, so this asks git rather than
 *  reimplementing its rules -- but a leading dash has to be caught FIRST,
 *  because such a name would be read as an option by the very command asked
 *  to validate it.
 */
export async function assertValidBranchName(
  projectId: string,
  name: string,
): Promise<void> {
  if (!name || name.startsWith("-")) {
    throw new BadRequestError("That is not a usable branch name");
  }

  // No `--` here: check-ref-format does not accept one, and treats it as the
  // name being checked. The leading-dash guard above is what makes that safe.
  const { exitCode } = await git(projectId, ["check-ref-format", "--branch", name]);

  if (exitCode !== 0) {
    throw new BadRequestError("That is not a usable branch name");
  }
}

/** Creates a branch at HEAD and switches to it. */
export async function createBranch(
  projectId: string,
  name: string,
): Promise<void> {
  await assertValidBranchName(projectId, name);

  // The `--` goes AFTER the name: it means "no pathspecs follow", which is
  // what disambiguates a branch from a file. Putting it before would make git
  // read the name as a pathspec instead.
  const { stderr, stdout, exitCode } = await git(projectId, [
    "checkout",
    "-b",
    name,
    "--",
  ]);

  if (exitCode !== 0) {
    const message = (stderr || stdout).trim().split("\n")[0] ?? "git failed";
    throw new BadRequestError(message, "GIT_FAILED");
  }
}

/** Switches to an existing branch, but only from a clean worktree.
 *
 *  git itself is more permissive: it carries uncommitted changes across when
 *  they do not conflict. That is a footgun in an editor where the files are
 *  also open in other people's tabs -- edits silently follow you onto another
 *  branch and get committed there. Refusing is the honest answer, and the
 *  message says what to do about it.
 */
export async function switchBranch(
  projectId: string,
  name: string,
): Promise<void> {
  await assertValidBranchName(projectId, name);

  const current = await status(projectId);
  if (current.changes.length > 0) {
    throw new BadRequestError(
      "Commit or discard your changes before switching branch",
      "WORKTREE_DIRTY",
    );
  }

  // `--` after the name, not before -- see createBranch.
  const { stderr, stdout, exitCode } = await git(projectId, [
    "checkout",
    name,
    "--",
  ]);

  if (exitCode !== 0) {
    const message = (stderr || stdout).trim().split("\n")[0] ?? "git failed";
    throw new BadRequestError(message, "GIT_FAILED");
  }
}

/** Throws away local changes to the given paths, whatever state they are in.
 *
 *  One recipe covers every state git can report, which is why it is three
 *  commands rather than a switch on the status letter:
 *
 *   1. `reset` unstages, so a staged change is discarded too rather than
 *      surviving in the index. A path that was not staged is unaffected.
 *   2. `checkout` restores tracked content from the index -- which after step 1
 *      is HEAD -- so a modification is undone and a deletion is brought back.
 *      It has nothing to say about a path that was never committed.
 *   3. `clean` removes what is still untracked, which is how a brand-new file
 *      (staged or not) goes away. Steps 2 and 3 are each no-ops for the states
 *      the other handles.
 *
 *  Exit codes are deliberately not checked past the first: `checkout` fails on
 *  an untracked path and `clean` has nothing to do for a tracked one, and
 *  neither is an error from the caller's point of view. What the user asked for
 *  is "leave nothing of my changes to these paths", and afterwards there is
 *  nothing -- the status the caller reads back is the real answer.
 *
 *  DESTRUCTIVE and not undoable: the work is not in a commit and git keeps no
 *  copy. The confirmation belongs in the UI, and does.
 */
export async function discard(
  projectId: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;

  await gitOrThrow(projectId, ["reset", "--", ...paths]);
  await git(projectId, ["checkout", "--", ...paths]);
  await git(projectId, ["clean", "-f", "--", ...paths]);
}

/** Splits a unified patch into the header and its hunks, as RAW TEXT.
 *
 *  Deliberately not the structured parse the editor does: `git apply` is fed
 *  these bytes back, so anything that reformatted them -- normalising a line
 *  ending, dropping a trailing space from a context line -- would produce a
 *  patch that no longer applies. Slicing at the `@@` lines preserves them
 *  exactly.
 *
 *  The header is everything before the first hunk (`diff --git`, `index`,
 *  `---`, `+++`), which every hunk needs in front of it to say which file it
 *  belongs to.
 */
export function splitHunks(patch: string): { header: string; hunks: string[] } {
  const lines = patch.split("\n");
  const header: string[] = [];
  const hunks: string[][] = [];

  for (const line of lines) {
    if (line.startsWith("@@")) {
      hunks.push([line]);
    } else if (hunks.length === 0) {
      header.push(line);
    } else {
      hunks[hunks.length - 1]?.push(line);
    }
  }

  return {
    header: header.length > 0 ? `${header.join("\n")}\n` : "",
    hunks: hunks.map((hunk) => `${hunk.join("\n")}\n`),
  };
}

/** Rebuilds a patch containing only the chosen hunks.
 *
 *  Indexes rather than patch text, because the CLIENT chooses which hunks and
 *  must never be able to say what is in them: `git apply` given an
 *  attacker-authored patch would happily stage a change to a path nobody
 *  picked. The patch applied here is always one git itself just produced.
 */
export function patchForHunks(patch: string, indexes: number[]): string {
  const { header, hunks } = splitHunks(patch);
  const wanted = [...new Set(indexes)].sort((a, b) => a - b);

  const chosen = wanted
    .filter((index) => index >= 0 && index < hunks.length)
    .map((index) => hunks[index] ?? "");

  if (chosen.length === 0) return "";

  return `${header}${chosen.join("")}`;
}

/** Stages, or unstages, individual hunks of one file.
 *
 *  The patch is written into the project's own `.git` directory rather than
 *  piped in: the project is bind-mounted into its container, so a file written
 *  here is readable there, and `execCapture` attaches no stdin. `.git` because
 *  git never reports its contents as a change, so a patch file cannot show up
 *  in the user's status even for the moment it exists.
 */
export async function applyHunks(
  projectId: string,
  relPath: string,
  indexes: number[],
  reverse: boolean,
): Promise<void> {
  if (indexes.length === 0) return;

  // Reversing works against what is staged; staging works against the worktree.
  const source = await diff(projectId, relPath, reverse);
  const patch = patchForHunks(source, indexes);

  if (!patch.trim()) {
    throw new BadRequestError("Those changes are no longer there", "STALE_HUNK");
  }

  const name = `.git/rc-hunk-${randomBytes(8).toString("hex")}.patch`;
  const hostPath = path.join(projectRoot(projectId), name);

  await fsp.writeFile(hostPath, patch, "utf8");

  try {
    const argv = ["apply", "--cached"];
    if (reverse) argv.push("--reverse");
    argv.push("--", name);

    const { stderr, stdout, exitCode } = await git(projectId, argv);

    if (exitCode !== 0) {
      const message = (stderr || stdout).trim().split("\n")[0] ?? "git failed";
      throw new BadRequestError(message, "GIT_FAILED");
    }
  } finally {
    // Even on failure: a patch left behind would sit in .git forever.
    await fsp.unlink(hostPath).catch(() => undefined);
  }
}

/** Parses `git remote -v`, which lists each remote twice -- once for fetch and
 *  once for push -- as `name<TAB>url (fetch|push)`.
 *
 *  Only the fetch URL is kept. They differ only in setups this cannot create,
 *  and showing one remote as two rows reads as a bug.
 */
export function parseRemotes(raw: string): GitRemote[] {
  const seen = new Map<string, string>();

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    const [name = "", rest = ""] = line.split("\t");
    if (!name || !rest) continue;
    if (!rest.endsWith("(fetch)")) continue;

    seen.set(name, rest.slice(0, -"(fetch)".length).trim());
  }

  return [...seen].map(([name, url]) => ({ name, url }));
}

export async function remotes(projectId: string): Promise<GitRemote[]> {
  if (!(await isRepo(projectId))) return [];

  const { stdout, exitCode } = await git(projectId, ["remote", "-v"]);
  if (exitCode !== 0) return [];

  return parseRemotes(stdout);
}

/** Transports a remote URL may use.
 *
 *  An allow-list rather than a deny-list, because git's `ext::` transport runs
 *  the rest of the string as a COMMAND -- `ext::sh -c ...` is remote code
 *  execution the moment anything fetches. `file://` is refused too: it would
 *  reach whatever the server can see rather than anything on the network.
 */
const REMOTE_URL = /^(?:https?|ssh|git):\/\/[^\s]+$|^[\w.-]+@[\w.-]+:[^\s]+$/;

export function isUsableRemoteUrl(url: string): boolean {
  if (!url || url.startsWith("-")) return false;
  return REMOTE_URL.test(url);
}

export async function addRemote(
  projectId: string,
  name: string,
  url: string,
): Promise<void> {
  await assertValidBranchName(projectId, name);

  if (!isUsableRemoteUrl(url)) {
    throw new BadRequestError(
      "A remote needs an http(s), ssh or git URL",
      "BAD_REMOTE_URL",
    );
  }

  const { stderr, stdout, exitCode } = await git(projectId, [
    "remote",
    "add",
    "--",
    name,
    url,
  ]);

  if (exitCode !== 0) {
    const message = (stderr || stdout).trim().split("\n")[0] ?? "git failed";
    throw new BadRequestError(message, "GIT_FAILED");
  }
}

export async function removeRemote(
  projectId: string,
  name: string,
): Promise<void> {
  await assertValidBranchName(projectId, name);
  await gitOrThrow(projectId, ["remote", "remove", "--", name]);
}

/** Fetches from a remote. Changes no file, so nothing needs dropping. */
export async function fetchRemote(
  projectId: string,
  name: string,
): Promise<void> {
  await assertValidBranchName(projectId, name);

  const { stderr, stdout, exitCode } = await git(projectId, [
    "fetch",
    "--",
    name,
  ]);

  if (exitCode !== 0) {
    const message = (stderr || stdout).trim().split("\n")[0] ?? "git failed";
    throw new BadRequestError(message, "GIT_FAILED");
  }
}

/** Pulls a branch from a remote, but only into a clean worktree.
 *
 *  Same reasoning as switchBranch: a merge into files other people have open
 *  is not something to do on top of uncommitted work. Rewrites the worktree,
 *  so the caller drops shared documents afterwards.
 */
export async function pullRemote(
  projectId: string,
  name: string,
  branch: string,
): Promise<void> {
  await assertValidBranchName(projectId, name);
  await assertValidBranchName(projectId, branch);

  const current = await status(projectId);
  if (current.changes.length > 0) {
    throw new BadRequestError(
      "Commit or discard your changes before pulling",
      "WORKTREE_DIRTY",
    );
  }

  const { stderr, stdout, exitCode } = await git(projectId, [
    "pull",
    "--ff-only",
    "--",
    name,
    branch,
  ]);

  if (exitCode !== 0) {
    const message = (stderr || stdout).trim().split("\n")[0] ?? "git failed";
    throw new BadRequestError(message, "GIT_FAILED");
  }
}

/** Reads the secret out of the environment rather than off the command line.
 *
 *  This is git's own credential protocol: a helper prints `username=` and
 *  `password=` and git reads them. The string itself is fixed and authored
 *  here — nothing a caller supplies reaches it — and the secret arrives in
 *  `RC_GIT_TOKEN`, which is the whole point. Process arguments are
 *  world-readable through /proc; a process's environment is readable only by
 *  its own uid.
 *
 *  The username is a constant because every forge that accepts a token over
 *  HTTPS ignores it and authenticates on the password field alone.
 */
const TOKEN_CREDENTIAL_HELPER =
  '!f() { echo username=token; echo "password=$RC_GIT_TOKEN"; }; f';

/** Removes the secret from anything git said, before it reaches a log, an
 *  error message or a screen.
 *
 *  This implementation never puts it in a URL, so in principle git has nothing
 *  to echo. The redaction costs nothing and the failure mode it guards against
 *  is silent, which is the sort worth guarding against. */
export function redactToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("***");
}

/** Pushes a branch, authenticating with a value supplied for THIS call only.
 *
 *  It is never written down: not to the database, not to the repository's
 *  config, not to a credential store, and not into the remote's URL. It lives
 *  in this process for the length of one exec, and in that exec's environment,
 *  and nowhere else.
 *
 *  Whether pushing is allowed at all is decided by the controller, not here.
 *  The container is shared by everyone with access to the project, so this is
 *  only safe when there is nobody else — see `docs/SECURITY.md`.
 */
export async function pushRemote(
  projectId: string,
  name: string,
  branch: string,
  token: string,
): Promise<void> {
  await assertValidBranchName(projectId, name);
  await assertValidBranchName(projectId, branch);

  if (!token) throw new BadRequestError("A push needs an access token");

  const { stderr, stdout, exitCode } = await git(
    projectId,
    [
      "-c",
      `credential.helper=${TOKEN_CREDENTIAL_HELPER}`,
      "push",
      "--",
      name,
      branch,
    ],
    {
      RC_GIT_TOKEN: token,
      // Without this git falls back to prompting on a tty it does not have,
      // and the exec hangs until the output cap rather than failing.
      GIT_TERMINAL_PROMPT: "0",
    },
  );

  if (exitCode !== 0) {
    const combined = redactToken((stderr || stdout).trim(), token);
    throw new BadRequestError(
      combined.split("\n")[0] ?? "git failed",
      "GIT_FAILED",
    );
  }
}
