import fsp from "node:fs/promises";
import type { TaskList, TaskRun, WorkspaceTask } from "@replit-clone/shared";
import { ensureContainer, MOUNT_POINT } from "../containers/containerManager.js";
import { execCapture } from "../containers/execCapture.js";
import { logger } from "../lib/logger.js";
import { BadRequestError } from "../utils/errors.js";
import { resolveInProject } from "../utils/projectPaths.js";
import { parseJsonc } from "./editorConfigService.js";
import { matchProblems } from "./problemMatchers.js";

/** `.vscode/tasks.json`. plan.md §10.10.
 *
 *  A project carried one run command and one test command. This is named
 *  tasks, groups, dependencies and problem matchers — and the matchers are the
 *  point: the problems panel already existed and was fed only by the language
 *  server, so a build's errors had nowhere to go but a terminal somebody has to
 *  read.
 *
 *  **What this deliberately does not run: background tasks.** VS Code's
 *  `isBackground` is a watch — a process that stays up and reports as it goes.
 *  This platform already has exactly one of those and calls it the dev server
 *  (§2.7), with a run lifecycle, a log, a preview and a reconciler behind it.
 *  A second, parallel notion of "a process that stays running" would be two
 *  things that can disagree about what is running. So a background task is
 *  refused **by name, with the reason**, rather than started and quietly
 *  abandoned when the request ends.
 */

/** How long a task may run. Generous, because a cold build genuinely takes
 *  minutes; bounded, because an exec nobody can cancel is a container that
 *  never frees. */
const TASK_TIMEOUT_MS = 10 * 60 * 1000;

/** The tail kept. A build log can be megabytes and the part anybody reads is
 *  the end — the same reasoning `featureBuild` uses. */
const MAX_OUTPUT = 64 * 1024;

const TASKS_FILE = ".vscode/tasks.json";

/** VS Code allows a string or an array of strings for `args`, and both are
 *  common. Assembled into one command line, because that is what a shell exec
 *  takes and because `command` alone is already a line in the `"shell"` type. */
function commandLine(raw: Record<string, unknown>): string {
  const command = typeof raw["command"] === "string" ? raw["command"].trim() : "";
  if (!command) return "";

  const args = raw["args"];
  if (!Array.isArray(args)) return command;

  const parts = args
    .filter((arg): arg is string => typeof arg === "string")
    // Quoted only where it matters. An arg with a space is one arg; quoting
    // every arg would break `npm run build -- --flag` forms people write.
    .map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg));

  return [command, ...parts].join(" ");
}

/** `problemMatcher` is a string, an array, or an object. All three appear in
 *  real files. Only the NAMES are honoured; an inline object matcher is
 *  ignored rather than half-understood. */
function matcherNames(raw: unknown): string[] {
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === "string");
  return [];
}

function groupOf(raw: unknown): WorkspaceTask["group"] {
  // VS Code allows `"group": "build"` and `"group": { "kind": "build" }`.
  const kind =
    typeof raw === "string"
      ? raw
      : typeof raw === "object" && raw !== null
        ? (raw as { kind?: unknown }).kind
        : undefined;

  return kind === "build" || kind === "test" ? kind : "none";
}

export function parseTasks(raw: unknown): TaskList {
  const problems: string[] = [];

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { tasks: [], problems: ["tasks.json must contain a JSON object"] };
  }

  const list = (raw as { tasks?: unknown }).tasks;
  if (!Array.isArray(list)) {
    return { tasks: [], problems: ['tasks.json must have a "tasks" array'] };
  }

  const tasks: WorkspaceTask[] = [];

  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const task = entry as Record<string, unknown>;

    const label = typeof task["label"] === "string" ? task["label"].trim() : "";
    if (!label) {
      problems.push("a task has no label");
      continue;
    }

    const command = commandLine(task);
    if (!command) {
      problems.push(`the task "${label}" has no command`);
      continue;
    }

    const dependsOn = Array.isArray(task["dependsOn"])
      ? task["dependsOn"].filter((name): name is string => typeof name === "string")
      : typeof task["dependsOn"] === "string"
        ? [task["dependsOn"]]
        : [];

    tasks.push({
      label,
      command,
      group: groupOf(task["group"]),
      dependsOn,
      // VS Code's default is parallel, which surprises people often enough to
      // be worth naming rather than inheriting silently.
      dependsOrder: task["dependsOrder"] === "sequence" ? "sequence" : "parallel",
      matchers: matcherNames(task["problemMatcher"]),
      cwd:
        typeof (task["options"] as { cwd?: unknown } | undefined)?.cwd === "string"
          ? ((task["options"] as { cwd: string }).cwd)
          : undefined,
      background: task["isBackground"] === true,
    });
  }

  // A duplicate label makes `dependsOn` ambiguous, and ambiguity here means
  // running the wrong thing rather than failing.
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.label)) {
      problems.push(`more than one task is called "${task.label}"`);
    }
    seen.add(task.label);
  }

  return { tasks, problems };
}

export async function readTasks(projectId: string): Promise<TaskList> {
  let text: string;
  try {
    text = await fsp.readFile(resolveInProject(projectId, TASKS_FILE), "utf8");
  } catch {
    // No tasks.json is the ordinary case, not a problem to report.
    return { tasks: [], problems: [] };
  }

  try {
    // The same JSONC reader `.vscode/settings.json` uses -- these files sit in
    // the same folder, are written by the same editor, and have comments in
    // them for the same reasons.
    return parseTasks(parseJsonc(text));
  } catch (error) {
    return {
      tasks: [],
      problems: [error instanceof Error ? error.message : "tasks.json could not be read"],
    };
  }
}

/** The order a task and its dependencies run in.
 *
 *  Returns the labels to run, dependencies first. A cycle is refused rather
 *  than broken, for the same reason `orderFeatures` refuses one: picking an
 *  order arbitrarily produces a build that works here and not in VS Code.
 */
export function resolveOrder(tasks: readonly WorkspaceTask[], label: string): string[] {
  const byLabel = new Map(tasks.map((task) => [task.label, task]));
  const order: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();

  const visit = (name: string, trail: string[]): void => {
    if (done.has(name)) return;
    if (visiting.has(name)) {
      throw new BadRequestError(
        `These tasks depend on each other: ${[...trail, name].join(" → ")}`,
      );
    }

    const task = byLabel.get(name);
    if (!task) {
      throw new BadRequestError(`There is no task called "${name}"`);
    }

    visiting.add(name);
    for (const dependency of task.dependsOn) visit(dependency, [...trail, name]);
    visiting.delete(name);

    done.add(name);
    order.push(name);
  };

  visit(label, []);
  return order;
}

async function runOne(projectId: string, task: WorkspaceTask): Promise<TaskRun> {
  if (task.background) {
    return {
      label: task.label,
      exitCode: 0,
      output: "",
      problems: [],
      // Named, with the reason. A watch is a dev server, and this platform has
      // one of those already -- with a lifecycle, a log and a reconciler.
      refusal:
        "This is a background task. Use the dev server for a watch — a second thing that stays running would be a second answer to what is running.",
    };
  }

  const container = await ensureContainer(projectId);
  const workingDir = task.cwd ? `${MOUNT_POINT}/${task.cwd.replace(/^\.?\//, "")}` : MOUNT_POINT;

  const { stdout, stderr, exitCode } = await execCapture(
    container,
    ["/bin/sh", "-c", task.command],
    {
      workingDir,
      ...(task.env ? { env: task.env } : {}),
      timeoutMs: TASK_TIMEOUT_MS,
    },
  );

  // Both streams, because compilers are inconsistent about which one they use
  // and a matcher that reads only stdout misses half of them.
  const output = `${stdout}${stderr}`.slice(-MAX_OUTPUT);

  return {
    label: task.label,
    exitCode,
    output,
    problems: matchProblems(output, task.matchers, task.label, task.cwd),
  };
}

/** Runs a task and whatever it depends on.
 *
 *  Dependencies first, and a failing dependency stops the chain: `build` that
 *  depends on `install` should not run when `install` failed, because what it
 *  would report is the consequence rather than the cause.
 */
export async function runTask(projectId: string, label: string): Promise<TaskRun[]> {
  const { tasks } = await readTasks(projectId);
  const order = resolveOrder(tasks, label);
  const byLabel = new Map(tasks.map((task) => [task.label, task]));

  const runs: TaskRun[] = [];

  for (const name of order) {
    const task = byLabel.get(name);
    if (!task) continue;

    const run = await runOne(projectId, task);
    runs.push(run);

    if (run.exitCode !== 0 && !run.refusal) {
      logger.info("a task failed", { projectId, label: name, exitCode: run.exitCode });
      break;
    }
  }

  return runs;
}
