import type { TaskProblem } from "@replit-clone/shared";

/** Turning a compiler's output into entries in the problems panel.
 *  plan.md §10.10.
 *
 *  **This is the half of `tasks.json` worth having.** Named tasks are a
 *  convenience over typing a command; a matcher is the thing that makes `tsc`
 *  in a terminal and `tsc` in the editor the same experience — click the error,
 *  land on the line.
 *
 *  VS Code ships these as `$tsc`, `$eslint-stylish` and so on, and the names
 *  are what real `tasks.json` files say. So the names are what this accepts:
 *  a file written for VS Code should work here, which is the same argument
 *  §10.9 makes about setting names.
 *
 *  **A matcher is a regex over output, and a regex over output is a thing that
 *  can be wrong in two directions.** Missing a line means a problem the panel
 *  never shows; matching too much means noise that makes the panel useless. The
 *  patterns below are deliberately anchored and specific, and every one has a
 *  test with real output from the tool it names.
 */

interface Matcher {
  /** Applied per line. Multi-line matchers exist in VS Code and are not
   *  supported here — every tool below reports one problem per line, and a
   *  multi-line state machine for the ones that do not is a larger thing than
   *  this row needs. */
  pattern: RegExp;
  file: number;
  line: number;
  column: number;
  severity: number;
  message: number;
  code?: number;
}

/** `tsc --pretty false`:
 *  `src/a.ts(12,5): error TS2304: Cannot find name 'x'.` */
const TSC: Matcher = {
  pattern: /^([^\s(].*)\((\d+),(\d+)\):\s+(error|warning|info)\s+(\w+\d+):\s+(.*)$/,
  file: 1,
  line: 2,
  column: 3,
  severity: 4,
  code: 5,
  message: 6,
};

/** eslint's compact format:
 *  `/path/a.js: line 1, col 1, Error - Unexpected (rule)` */
const ESLINT_COMPACT: Matcher = {
  pattern: /^(.+):\s+line\s+(\d+),\s+col\s+(\d+),\s+(Error|Warning|Info)\s+-\s+(.+)$/,
  file: 1,
  line: 2,
  column: 3,
  severity: 4,
  message: 5,
};

/** eslint's default "stylish" reporter puts the FILE on its own line and the
 *  problems under it, indented. That is a two-state parser rather than a
 *  regex, which is why it is handled separately below. */
const ESLINT_STYLISH_FILE = /^(?!\s)(\S.*\.[a-zA-Z]+)$/;
const ESLINT_STYLISH_ENTRY =
  /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/;

/** `go build`: `./main.go:7:2: undefined: foo` */
const GO: Matcher = {
  pattern: /^(.+\.go):(\d+):(\d+):\s+(.+)$/,
  file: 1,
  line: 2,
  column: 3,
  // Go says nothing about severity; everything it prints here is an error.
  severity: 0,
  message: 4,
};

/** gcc and clang: `main.c:5:9: error: 'x' undeclared` */
const GCC: Matcher = {
  pattern: /^(.+?):(\d+):(\d+):\s+(error|warning|note):\s+(.+)$/,
  file: 1,
  line: 2,
  column: 3,
  severity: 4,
  message: 5,
};

/** Deliberately no Python matcher.
 *
 *  A traceback line -- `  File "app.py", line 12, in <module>` -- carries a
 *  file and a line and NO message: the message is somewhere else entirely, on
 *  the last line of the traceback. A matcher built on it would fill the
 *  problems panel with entries whose text is the traceback line itself, which
 *  is worse than an empty panel: it looks like the feature works. Whoever adds
 *  one should parse the whole traceback, and that is a state machine rather
 *  than a regex.
 */

const NAMED: Record<string, Matcher> = {
  $tsc: TSC,
  "$tsc-watch": TSC,
  $eslint: ESLINT_COMPACT,
  "$eslint-compact": ESLINT_COMPACT,
  $go: GO,
  $gcc: GCC,
  $msCompile: GCC,
};

/** The severity words every tool above uses, in every case they use them. */
function toSeverity(word: string): TaskProblem["severity"] {
  const lower = word.toLowerCase();
  if (lower.startsWith("warn")) return "warning";
  if (lower === "note" || lower === "info") return "info";
  return "error";
}

/** Paths a tool prints are relative to where it ran, and often carry `./`.
 *
 *  Normalised here rather than left to the client, because the problems panel
 *  matches on this string to open a file — and `./src/a.ts` and `src/a.ts` are
 *  the same file to everybody except a string comparison.
 */
export function normalisePath(raw: string, cwd?: string): string {
  let path = raw.trim().replace(/\\/g, "/");
  if (path.startsWith("./")) path = path.slice(2);

  // An absolute path inside the container. The panel wants project-relative.
  const mount = "/home/sandbox/app/";
  const at = path.indexOf(mount);
  if (at !== -1) path = path.slice(at + mount.length);

  if (cwd && !path.startsWith("/")) {
    const prefix = cwd.replace(/^\.\//, "").replace(/\/$/, "");
    if (prefix) path = `${prefix}/${path}`;
  }

  return path.replace(/^\/+/, "");
}

function applyOne(
  matcher: Matcher,
  output: string,
  source: string,
  cwd?: string,
): TaskProblem[] {
  const problems: TaskProblem[] = [];

  for (const line of output.split("\n")) {
    const match = matcher.pattern.exec(line.trimEnd());
    if (!match) continue;

    const file = match[matcher.file];
    const lineNumber = Number(match[matcher.line]);
    if (file === undefined || !Number.isFinite(lineNumber)) continue;

    const code = matcher.code ? match[matcher.code] : undefined;
    const body = matcher.message ? (match[matcher.message] ?? "") : line.trim();

    problems.push({
      relPath: normalisePath(file, cwd),
      line: lineNumber,
      column: matcher.column ? Number(match[matcher.column] ?? 1) || 1 : 1,
      severity: matcher.severity ? toSeverity(match[matcher.severity] ?? "error") : "error",
      message: code ? `${code}: ${body}` : body,
      source,
    });
  }

  return problems;
}

/** eslint's stylish reporter, which is the default and therefore the one most
 *  people's output actually looks like. Two states: a file heading, then its
 *  indented problems. */
function applyStylish(output: string, source: string, cwd?: string): TaskProblem[] {
  const problems: TaskProblem[] = [];
  let file: string | null = null;

  for (const raw of output.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") continue;

    const heading = ESLINT_STYLISH_FILE.exec(line);
    if (heading?.[1]) {
      file = heading[1];
      continue;
    }

    const entry = ESLINT_STYLISH_ENTRY.exec(line);
    // An indented problem with no file above it is output this parser does not
    // understand, not a problem at line 0 of nothing.
    if (!entry || file === null) continue;

    problems.push({
      relPath: normalisePath(file, cwd),
      line: Number(entry[1]) || 1,
      column: Number(entry[2]) || 1,
      severity: toSeverity(entry[3] ?? "error"),
      message: entry[5] ? `${entry[4] ?? ""} (${entry[5]})` : (entry[4] ?? ""),
      source,
    });
  }

  return problems;
}

/** Every problem the named matchers find in one task's output.
 *
 *  Deduplicated, because two matchers on one task legitimately overlap —
 *  `$eslint` and `$eslint-stylish` on the same run would otherwise report each
 *  problem twice, and a panel that double-counts is one people stop trusting.
 */
export function matchProblems(
  output: string,
  matchers: readonly string[],
  source: string,
  cwd?: string,
): TaskProblem[] {
  const found: TaskProblem[] = [];

  for (const name of matchers) {
    if (name === "$eslint-stylish") {
      found.push(...applyStylish(output, source, cwd));
      continue;
    }

    const matcher = NAMED[name];
    // An unknown matcher name is silently no problems rather than an error:
    // `tasks.json` files name matchers this platform has never heard of, and
    // refusing the task over it would be refusing to run a build because its
    // output could not be parsed.
    if (matcher) found.push(...applyOne(matcher, output, source, cwd));
  }

  const seen = new Set<string>();
  return found.filter((problem) => {
    const key = `${problem.relPath}:${String(problem.line)}:${String(problem.column)}:${problem.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The matcher names this understands, for the editor to show. */
export const KNOWN_MATCHERS = [...Object.keys(NAMED), "$eslint-stylish"];
