/** `tasks.json`, and the matchers that turn output into problems.
 *  plan.md §10.10.
 *
 *  A project carried exactly one run command and one test command. VS Code has
 *  named tasks, build-versus-test groups, tasks that depend on other tasks, and
 *  problem matchers that turn compiler output into entries in the problems
 *  panel — which already exists here and was fed only by the language server.
 *  That last part is why this row and §13.5 were sequenced together: the panel
 *  is one surface with three feeds.
 */

/** One task, as this platform understands it. */
export interface WorkspaceTask {
  /** `label` in the file, and the id everywhere else. */
  label: string;
  /** The command line, already assembled from `command` and `args`. */
  command: string;
  /** VS Code's `group`. Only these two mean anything here. */
  group: "build" | "test" | "none";
  /** Labels that must run first. */
  dependsOn: string[];
  /** Whether dependencies run one after another or together. VS Code's
   *  default is parallel, which is surprising often enough to be worth
   *  stating rather than inheriting silently. */
  dependsOrder: "parallel" | "sequence";
  /** Which matcher names to apply to the output. Empty means none, and none
   *  means the output is shown and nothing is added to the problems panel. */
  matchers: string[];
  /** Where to run it, relative to the project root. */
  cwd?: string;
  /** Extra environment for this task only. */
  env?: Record<string, string>;
  /** True when the file says this is a background/watch task. Not run here —
   *  see `TaskRun.refusal`. */
  background: boolean;
}

export interface TaskList {
  tasks: WorkspaceTask[];
  /** Problems with `tasks.json` itself. Reported rather than swallowed: a task
   *  file that silently does nothing is the worst of the three outcomes. */
  problems: string[];
}

/** One diagnostic a matcher found. The same shape the problems panel already
 *  holds, so a task's output and the language server's diagnostics land in one
 *  list rather than two. */
export interface TaskProblem {
  relPath: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning" | "info";
  /** The task that produced it, so the panel can say where it came from. */
  source: string;
}

export interface TaskRun {
  label: string;
  exitCode: number;
  /** The tail of the output. A build log can be megabytes and the part anybody
   *  reads is the end. */
  output: string;
  problems: TaskProblem[];
  /** Set when the task was not run at all, with the reason. A background task
   *  is the ordinary case: a watch is a dev server, and this platform already
   *  has one of those. */
  refusal?: string;
}
