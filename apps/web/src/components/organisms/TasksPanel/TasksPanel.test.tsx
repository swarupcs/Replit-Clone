// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TaskList, TaskRun } from "@replit-clone/shared";

const getTasks = vi.fn();
const runTask = vi.fn();
vi.mock("../../../apis/projects.ts", () => ({
  getTasksApi: () => getTasks() as unknown,
  runTaskApi: (_id: string, label: string) => runTask(label) as unknown,
}));

import { TasksPanel } from "./TasksPanel.tsx";
import { useProblemsStore } from "../../../store/problemsStore.ts";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function list(over: Partial<TaskList> = {}): TaskList {
  return {
    tasks: [
      {
        label: "build",
        command: "npm run build",
        group: "build",
        dependsOn: [],
        dependsOrder: "parallel",
        matchers: ["$tsc"],
        background: false,
      },
    ],
    problems: [],
    ...over,
  };
}

function run(over: Partial<TaskRun> = {}): TaskRun {
  return {
    label: "build",
    exitCode: 1,
    output: "src/a.ts(1,1): error TS1: broken",
    problems: [
      {
        relPath: "src/a.ts",
        line: 1,
        column: 1,
        message: "TS1: broken",
        severity: "error",
        source: "build",
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  getTasks.mockReset().mockResolvedValue(list());
  runTask.mockReset().mockResolvedValue([run()]);
  useProblemsStore.setState({ problems: [], taskProblems: [] });
});

afterEach(() => {
  cleanup();
});

describe("tasks", () => {
  it("lists what the file declares, with its command", async () => {
    render(<TasksPanel projectId={PROJECT} canRun />);
    expect(await screen.findByText("npm run build")).toBeTruthy();
  });

  it("puts a run's problems into the problems panel", async () => {
    // The point of the row: a build error becomes something you click rather
    // than something you read in a terminal and then go looking for.
    render(<TasksPanel projectId={PROJECT} canRun />);
    fireEvent.click(await screen.findByRole("button", { name: "Run build" }));

    await waitFor(() => {
      expect(useProblemsStore.getState().taskProblems).toHaveLength(1);
    });
    expect(useProblemsStore.getState().taskProblems[0]?.relPath).toBe("src/a.ts");
  });

  it("replaces the previous run's problems rather than adding to them", async () => {
    render(<TasksPanel projectId={PROJECT} canRun />);
    fireEvent.click(await screen.findByRole("button", { name: "Run build" }));
    await waitFor(() => {
      expect(useProblemsStore.getState().taskProblems).toHaveLength(1);
    });

    // The store updates inside the request's `try`, before `finally` clears
    // the loading flag -- so waiting on the store alone leaves the button still
    // loading, and antd swallows a click on a loading button.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Run build" }).className,
      ).not.toContain("loading");
    });

    runTask.mockResolvedValue([run({ exitCode: 0, problems: [], output: "ok" })]);
    fireEvent.click(screen.getByRole("button", { name: "Run build" }));
    await waitFor(() => {
      expect(runTask).toHaveBeenCalledTimes(2);
    });

    // A fixed error must not stay on screen until somebody reloads.
    await waitFor(() => {
      expect(useProblemsStore.getState().taskProblems).toHaveLength(0);
    });
  });

  it("does not touch the language server's problems", async () => {
    // Two lists with different lifetimes: markers are recomputed on every
    // keystroke, and a task's problems are true until it runs again.
    useProblemsStore.setState({
      problems: [
        {
          relPath: "b.ts",
          line: 1,
          column: 1,
          message: "from tsserver",
          severity: "warning",
          source: "ts",
        },
      ],
    });

    render(<TasksPanel projectId={PROJECT} canRun />);
    fireEvent.click(await screen.findByRole("button", { name: "Run build" }));

    await waitFor(() => {
      expect(useProblemsStore.getState().taskProblems).toHaveLength(1);
    });
    expect(useProblemsStore.getState().problems).toHaveLength(1);
  });

  it("shows the refusal for a background task rather than pretending it ran", async () => {
    runTask.mockResolvedValue([
      run({ problems: [], output: "", refusal: "This is a background task." }),
    ]);

    render(<TasksPanel projectId={PROJECT} canRun />);
    fireEvent.click(await screen.findByRole("button", { name: "Run build" }));

    expect(await screen.findByText(/background task/)).toBeTruthy();
  });

  it("reports a broken tasks.json", async () => {
    getTasks.mockResolvedValue(list({ tasks: [], problems: ['a task has no label'] }));
    render(<TasksPanel projectId={PROJECT} canRun />);

    expect(await screen.findByText("tasks.json has problems")).toBeTruthy();
  });

  it("says where tasks come from when there are none", async () => {
    getTasks.mockResolvedValue({ tasks: [], problems: [] });
    render(<TasksPanel projectId={PROJECT} canRun />);

    expect(await screen.findByText(/\.vscode\/tasks\.json/)).toBeTruthy();
  });

  it("offers a viewer no way to run one", async () => {
    render(<TasksPanel projectId={PROJECT} canRun={false} />);
    await screen.findByText("npm run build");

    expect(screen.queryByRole("button", { name: "Run build" })).toBeNull();
  });
});
