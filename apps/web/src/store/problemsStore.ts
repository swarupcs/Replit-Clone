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
  /** Every current problem, worst first, then by file and position. */
  problems: Problem[];
  setProblems: (problems: Problem[]) => void;
}

export const useProblemsStore = create<ProblemsStore>((set) => ({
  problems: [],

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
export const selectErrorCount = (state: ProblemsStore): number =>
  state.problems.reduce(
    (total, problem) => total + (problem.severity === "error" ? 1 : 0),
    0,
  );

export const selectWarningCount = (state: ProblemsStore): number =>
  state.problems.reduce(
    (total, problem) => total + (problem.severity === "warning" ? 1 : 0),
    0,
  );
