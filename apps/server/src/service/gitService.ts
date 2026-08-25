import type {
  GitBranch,
  GitChange,
  GitChangeState,
  GitCommit,
  GitStatus,
} from "@replit-clone/shared";
import { ensureContainer } from "../containers/containerManager.js";
import { execCapture } from "../containers/execCapture.js";
import { BadRequestError } from "../utils/errors.js";
import { assertValidProjectId } from "../utils/projectPaths.js";

const APP_DIR = "/home/sandbox/app";

/** The shapes below are declared once, in the shared package, so the web app
 *  and this service cannot drift apart on what a change looks like. */
export type {
  GitBranch,
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
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const container = await ensureContainer(assertValidProjectId(projectId));
  return execCapture(container, ["git", ...argv], { workingDir: APP_DIR });
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

export async function commit(
  projectId: string,
  message: string,
  author: { name: string; email: string },
): Promise<GitCommit[]> {
  const trimmed = message.trim();
  if (!trimmed) throw new BadRequestError("A commit needs a message");

  const { stdout, stderr, exitCode } = await git(projectId, [
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
