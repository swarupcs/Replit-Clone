// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  selectErrorCount,
  selectWarningCount,
  useProblemsStore,
} from "./problemsStore.ts";

function problem(severity: "error" | "warning" | "info", relPath = "a.ts") {
  return { relPath, line: 1, column: 1, message: "x", severity, source: "ts" };
}

beforeEach(() => {
  useProblemsStore.setState({ problems: [], taskProblems: [] });
});

describe("what the status bar counts", () => {
  it("counts the language server's problems", () => {
    useProblemsStore.setState({ problems: [problem("error"), problem("warning")] });
    expect(selectErrorCount(useProblemsStore.getState())).toBe(1);
    expect(selectWarningCount(useProblemsStore.getState())).toBe(1);
  });

  it("counts a task's problems too -- plan.md §10.10", () => {
    // A count that omits the build's errors says "everything is fine" while
    // the build is red.
    useProblemsStore.setState({ taskProblems: [problem("error", "b.ts")] });
    expect(selectErrorCount(useProblemsStore.getState())).toBe(1);
  });

  it("adds the two feeds rather than replacing one with the other", () => {
    useProblemsStore.setState({
      problems: [problem("error")],
      taskProblems: [problem("error", "b.ts"), problem("warning", "c.ts")],
    });

    expect(selectErrorCount(useProblemsStore.getState())).toBe(2);
    expect(selectWarningCount(useProblemsStore.getState())).toBe(1);
  });

  it("ignores info in both", () => {
    useProblemsStore.setState({
      problems: [problem("info")],
      taskProblems: [problem("info", "b.ts")],
    });
    expect(selectErrorCount(useProblemsStore.getState())).toBe(0);
    expect(selectWarningCount(useProblemsStore.getState())).toBe(0);
  });
});
