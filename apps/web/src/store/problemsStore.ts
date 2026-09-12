import { create } from "zustand";

/** One diagnostic, flattened out of a Monaco marker.
 *
 *  Monaco's own marker type carries a `resource` URI and an owner; neither
 *  means anything outside the editor, so what reaches the panel is a path and
 *  a position, the same shape a search result has.
 */
export interface Problem {
  relPath: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning" | "info";
  /** Which language service said so — "ts", "json", "css". Absent for markers
   *  that do not name one. */
  source: string | undefined;
}

interface ProblemsStore {
  /** Every current problem from the language server, worst first, then by file
   *  and position. */
  problems: Problem[];
  setProblems: (problems: Problem[]) => void;

  /** What a task's problem matcher found -- plan.md §10.10.
   *
   *  A SECOND list rather than merged into the first, and the reason is the
   *  lifetime: language-server markers are recomputed on every keystroke and
   *  replaced wholesale, while a task's problems are true until the task runs
   *  again. Merging them would mean the next keystroke silently deleting a
   *  build's errors -- which is the moment somebody most needs to see them.
   */
  taskProblems: Problem[];
  setTaskProblems: (problems: Problem[]) => void;
}

export const useProblemsStore = create<ProblemsStore>((set) => ({
  problems: [],
  taskProblems: [],

  setTaskProblems: (taskProblems) =>
    set((state) =>
      same(state.taskProblems, taskProblems) ? state : { taskProblems },
    ),

  setProblems: (problems) =>
    set((state) =>
      // Markers are recomputed on every keystroke in a file, and almost always
      // come back identical. A new array each time would re-render the panel
      // and the status bar for nothing.
      same(state.problems, problems) ? state : { problems },
    ),
}));

function same(a: Problem[], b: Problem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((problem, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      problem.relPath === other.relPath &&
      problem.line === other.line &&
      problem.column === other.column &&
      problem.message === other.message &&
      problem.severity === other.severity
    );
  });
}

/** One number per selector, not a `{ errors, warnings }` object.
 *
 *  A selector that builds an object returns a new identity every call, and
 *  zustand compares with `Object.is` — so a counts object re-rendered its
 *  subscriber on every store read, which is every keystroke anywhere, forever.
 *  Numbers compare equal.
 */
/** Both feeds, because the status bar's number has to be the number of
 *  problems -- a count that omits the build's errors is a count that says
 *  "everything is fine" while the build is red. plan.md §10.10. */
export const selectErrorCount = (state: ProblemsStore): number =>
  count(state, "error");

export const selectWarningCount = (state: ProblemsStore): number =>
  count(state, "warning");

function count(state: ProblemsStore, severity: Problem["severity"]): number {
  let total = 0;
  for (const problem of state.problems) {
    if (problem.severity === severity) total += 1;
  }
  for (const problem of state.taskProblems) {
    if (problem.severity === severity) total += 1;
  }
  return total;
}
