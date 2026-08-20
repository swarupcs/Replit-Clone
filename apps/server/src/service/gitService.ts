import { ensureContainer } from "../containers/containerManager.js";
import { execCapture } from "../containers/execCapture.js";
import { BadRequestError } from "../utils/errors.js";
import { assertValidProjectId } from "../utils/projectPaths.js";

const APP_DIR = "/home/sandbox/app";

export type ChangeState =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked";

export interface GitChange {
  path: string;
  /** Set only for a rename, naming where the file came from. */
  from?: string;
  /** What the index has, versus HEAD. */
  staged?: ChangeState;
  /** What the working tree has, versus the index. */
  unstaged?: ChangeState;
}

export interface GitStatus {
  /** False when the project has no repository yet, in which case nothing else
   *  here is meaningful. */
  isRepo: boolean;
  branch?: string;
  /** Commits ahead of / behind the upstream, when there is one. */
  ahead?: number;
  behind?: number;
  /** True before the first commit, when HEAD points at an unborn branch. */
  unborn?: boolean;
  changes: GitChange[];
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

/** Maps one half of a porcelain status code to a state.
 *
 *  The two columns mean different things -- the first is index-versus-HEAD, the
 *  second is worktree-versus-index -- but the letters are shared. */
function toState(code: string): ChangeState | undefined {
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
