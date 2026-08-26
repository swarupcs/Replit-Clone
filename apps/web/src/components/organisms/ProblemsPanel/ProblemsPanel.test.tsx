// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProblemsPanel } from "./ProblemsPanel.tsx";
import { useProblemsStore, type Problem } from "../../../store/problemsStore.ts";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
import { useOpenTabsStore } from "../../../store/openTabsStore.ts";

function problem(overrides: Partial<Problem> = {}): Problem {
  return {
    relPath: "src/App.tsx",
    line: 12,
    column: 3,
    message: "Unexpected token",
    severity: "error",
    source: "ts",
    ...overrides,
  };
}

const emit = vi.fn();

beforeEach(() => {
  emit.mockClear();
  useProblemsStore.setState({ problems: [] });
  useEditorSocketStore.setState({
    editorSocket: { emit } as unknown as ReturnType<
      typeof useEditorSocketStore.getState
    >["editorSocket"],
  });
  useOpenTabsStore.setState({ pendingReveal: null });
});

afterEach(() => {
  cleanup();
});

describe("ProblemsPanel", () => {
  it("says what a clean list does and does not mean", () => {
    render(<ProblemsPanel />);

    expect(screen.getByText(/No problems detected/)).toBeDefined();
    // Semantic validation is off by design, so an empty list is NOT "this
    // project type checks". Claiming otherwise would be worse than no panel.
    expect(screen.getByText(/Syntax and schema only/)).toBeDefined();
  });

  it("groups problems under the file they are in", () => {
    useProblemsStore.setState({
      problems: [
        problem(),
        problem({ line: 40, message: "Missing semicolon" }),
        problem({ relPath: "src/api.ts", message: "Bad JSON" }),
      ],
    });
    render(<ProblemsPanel />);

    expect(screen.getByText("App.tsx")).toBeDefined();
    expect(screen.getByText("api.ts")).toBeDefined();
    // The per-file count: two in one file, one in the other.
    expect(screen.getByText("2")).toBeDefined();
  });

  it("opens the file and asks for the cursor to be put on the problem", () => {
    useProblemsStore.setState({ problems: [problem()] });
    render(<ProblemsPanel />);

    fireEvent.click(screen.getByText("Unexpected token"));

    expect(emit).toHaveBeenCalledWith("readFile", { relPath: "src/App.tsx" });
    expect(useOpenTabsStore.getState().pendingReveal).toEqual({
      relPath: "src/App.tsx",
      line: 12,
      column: 3,
    });
  });

  it("makes each problem a real button, so the list is not mouse-only", () => {
    useProblemsStore.setState({ problems: [problem()] });
    render(<ProblemsPanel />);

    expect(
      screen.getByRole("button", { name: /Unexpected token/ }).tagName,
    ).toBe("BUTTON");
  });

  it("distinguishes a warning from an error to a screen reader", () => {
    useProblemsStore.setState({
      problems: [problem(), problem({ severity: "warning", line: 2 })],
    });
    render(<ProblemsPanel />);

    // The severity is carried by colour alone otherwise.
    expect(screen.getByLabelText("Error")).toBeDefined();
    expect(screen.getByLabelText("Warning")).toBeDefined();
  });
});

describe("the problems store", () => {
  it("counts each severity separately", () => {
    useProblemsStore.setState({
      problems: [
        problem(),
        problem({ severity: "warning" }),
        problem({ severity: "warning" }),
        problem({ severity: "info" }),
      ],
    });

    const state = useProblemsStore.getState();
    expect(state.problems.filter((p) => p.severity === "error")).toHaveLength(1);
    expect(state.problems.filter((p) => p.severity === "warning")).toHaveLength(
      2,
    );
  });

  it("ignores a republish that changes nothing", () => {
    const { setProblems } = useProblemsStore.getState();
    setProblems([problem()]);
    const before = useProblemsStore.getState().problems;

    // Markers are recomputed on every keystroke and almost always come back
    // identical; a new array each time would re-render the panel for nothing.
    setProblems([problem()]);

    expect(useProblemsStore.getState().problems).toBe(before);
  });
});
