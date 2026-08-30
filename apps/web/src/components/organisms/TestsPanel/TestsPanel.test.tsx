// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

/** The tests panel.
 *
 *  What is worth testing is the reporting rather than the form. "Failed" with
 *  nothing under it is what sends somebody back to a terminal, which is the
 *  thing this panel exists to replace — so the output has to be there, and
 *  "we could not run them" must not read as "your tests failed".
 */
const getCommand = vi.fn();
const setCommand = vi.fn();
const runTests = vi.fn();

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return { ...actual, message: toast };
});

vi.mock("../../../apis/tests.ts", () => ({
  getTestCommandApi: (projectId: string) => getCommand(projectId) as unknown,
  setTestCommandApi: (projectId: string, command: string) =>
    setCommand(projectId, command) as unknown,
  runTestsApi: (projectId: string) => runTests(projectId) as unknown,
}));

import { TestsPanel } from "./TestsPanel.tsx";

const run = (status: string, output: string, exitCode: number | null = 0) => ({
  status,
  command: "npm test",
  exitCode,
  output,
  startedAt: new Date(Date.now() - 4200).toISOString(),
  finishedAt: new Date().toISOString(),
});

const show = (canRun = true, isOwner = true) =>
  render(
    <TestsPanel projectId="p1" canRun={canRun} isOwner={isOwner} />,
  );

beforeEach(() => {
  getCommand.mockReset().mockResolvedValue({
    command: "npm test",
    fromTemplate: true,
  });
  setCommand.mockReset().mockResolvedValue({
    command: "npm run test:ci",
    fromTemplate: false,
  });
  runTests.mockReset().mockResolvedValue(run("PASSED", "12 passed"));
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(cleanup);

describe("what it says it will run", () => {
  it("shows the command, and that it came from the template", async () => {
    // "The template chose this" and "the owner chose this" are different
    // facts, and only one of them is anybody's decision.
    show();

    expect(await screen.findByText("npm test")).toBeTruthy();
    expect(screen.getByText("from this template")).toBeTruthy();
  });

  it("does not claim a template source for the owner's own command", async () => {
    getCommand.mockResolvedValue({
      command: "npm run test:ci",
      fromTemplate: false,
    });
    show();

    expect(await screen.findByText("npm run test:ci")).toBeTruthy();
    expect(screen.queryByText("from this template")).toBeNull();
  });

  it("explains itself when nothing names a command", async () => {
    getCommand.mockResolvedValue({ command: null, fromTemplate: false });
    show();

    expect(await screen.findByText(/No test command yet/i)).toBeTruthy();
    expect(screen.queryByLabelText("Run the tests")).toBeNull();
  });

  it("tells a non-owner whose job it is to set one", async () => {
    getCommand.mockResolvedValue({ command: null, fromTemplate: false });
    show(true, false);

    expect(await screen.findByText(/owner can set one/i)).toBeTruthy();
  });
});

describe("reporting a run", () => {
  it("shows the output when they pass", async () => {
    show();

    fireEvent.click(await screen.findByLabelText("Run the tests"));

    expect(await screen.findByText("passed")).toBeTruthy();
    expect(screen.getByLabelText("Test output").textContent).toContain(
      "12 passed",
    );
  });

  it("keeps the failure output, which is the whole answer", async () => {
    runTests.mockResolvedValue(
      run("FAILED", "1 failing\n  expected 2 to equal 3", 1),
    );
    show();

    fireEvent.click(await screen.findByLabelText("Run the tests"));

    expect(await screen.findByText("failed")).toBeTruthy();
    expect(screen.getByLabelText("Test output").textContent).toContain(
      "expected 2 to equal 3",
    );
  });

  it("does not call a machine failure a test failure", async () => {
    // "could not run", not "failed". Otherwise a Docker outage sends somebody
    // to read their own code.
    runTests.mockResolvedValue(run("ERRORED", "docker is down", null));
    show();

    fireEvent.click(await screen.findByLabelText("Run the tests"));

    expect(await screen.findByText("could not run")).toBeTruthy();
    expect(screen.queryByText("failed")).toBeNull();
  });

  it("distinguishes a run that took too long", async () => {
    runTests.mockResolvedValue(run("TIMED_OUT", "Gave up after 10 minutes.", null));
    show();

    fireEvent.click(await screen.findByLabelText("Run the tests"));

    expect(await screen.findByText("timed out")).toBeTruthy();
  });

  it("clears the previous result before running again", async () => {
    // A stale result beside a spinner reads as the current one.
    show();
    fireEvent.click(await screen.findByLabelText("Run the tests"));
    expect(await screen.findByText("passed")).toBeTruthy();

    // The first run has to have SETTLED before the second click, or the button
    // is still loading and swallows it -- which under load is exactly what
    // happened, and made this test fail for a reason that had nothing to do
    // with what it is about.
    const button = screen.getByLabelText("Run the tests");
    await waitFor(() => {
      expect(button.className).not.toContain("loading");
    });

    let release: (value: unknown) => void = () => undefined;
    runTests.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.queryByText("passed")).toBeNull();
    });

    // Settled so the component is not left updating after the test ends.
    release(run("PASSED", "12 passed"));
    await waitFor(() => {
      expect(screen.queryByText("passed")).toBeTruthy();
    });
  });

  it("says so when the run could not even be requested", async () => {
    runTests.mockRejectedValue(new Error("This project has no test command."));
    show();

    fireEvent.click(await screen.findByLabelText("Run the tests"));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "This project has no test command.",
      );
    });
  });
});

describe("who may do what", () => {
  it("hides the run button from somebody who may only read", async () => {
    // Running executes code in the container -- the grant Run needs, not one
    // read-only access implies.
    show(false, false);

    expect(await screen.findByText("npm test")).toBeTruthy();
    expect(screen.queryByLabelText("Run the tests")).toBeNull();
  });

  it("lets only the owner change the command", async () => {
    show(true, false);

    expect(await screen.findByText("npm test")).toBeTruthy();
    expect(screen.queryByLabelText("Test command")).toBeNull();
  });

  it("saves the owner's command", async () => {
    show();

    fireEvent.change(await screen.findByLabelText("Test command"), {
      target: { value: "npm run test:ci" },
    });
    fireEvent.click(screen.getByLabelText("Save the test command"));

    await waitFor(() => {
      expect(setCommand).toHaveBeenCalledWith("p1", "npm run test:ci");
    });
  });

  it("sends an empty command, which means back to the default", async () => {
    getCommand.mockResolvedValue({
      command: "npm run test:ci",
      fromTemplate: false,
    });
    setCommand.mockResolvedValue({ command: "npm test", fromTemplate: true });
    show();

    const input = await screen.findByLabelText("Test command");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("Save the test command"));

    await waitFor(() => {
      expect(setCommand).toHaveBeenCalledWith("p1", "");
    });
  });
});
