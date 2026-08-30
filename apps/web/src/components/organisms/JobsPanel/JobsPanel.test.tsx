// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ScheduledJob } from "@replit-clone/shared";

const listJobs = vi.fn();
const createJob = vi.fn();
const updateJob = vi.fn();
const deleteJob = vi.fn();
const runJob = vi.fn();

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return { ...actual, message: toast };
});

vi.mock("../../../apis/schedules.ts", () => ({
  listJobsApi: (projectId: string) => listJobs(projectId) as unknown,
  createJobApi: (projectId: string, input: unknown) =>
    createJob(projectId, input) as unknown,
  updateJobApi: (projectId: string, jobId: string, input: unknown) =>
    updateJob(projectId, jobId, input) as unknown,
  deleteJobApi: (projectId: string, jobId: string) =>
    deleteJob(projectId, jobId) as unknown,
  runJobApi: (projectId: string, jobId: string) =>
    runJob(projectId, jobId) as unknown,
}));

import { JobsPanel } from "./JobsPanel.tsx";

/** The scheduled jobs panel.
 *
 *  What is worth testing is the reporting, not the form. A schedule's failure
 *  mode is silence: the job that has been exiting 1 every night for a month
 *  looks exactly like the one that works, unless this panel makes the
 *  difference visible without anybody opening anything.
 */
const NIGHTLY: ScheduledJob = {
  id: "j1",
  projectId: "p1",
  name: "Nightly backup",
  schedule: "0 3 * * *",
  command: "npm run backup",
  enabled: true,
  nextRunAt: new Date(Date.now() + 90 * 60_000).toISOString(),
  createdAt: new Date().toISOString(),
  lastRun: null,
};

const show = (isOwner = true) =>
  render(<JobsPanel projectId="p1" isOwner={isOwner} />);

beforeEach(() => {
  listJobs.mockReset().mockResolvedValue([]);
  createJob.mockReset().mockResolvedValue(NIGHTLY);
  updateJob.mockReset().mockResolvedValue(NIGHTLY);
  deleteJob.mockReset().mockResolvedValue(undefined);
  runJob.mockReset().mockResolvedValue({ id: "r1", status: "SUCCEEDED" });
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(cleanup);

describe("an empty project", () => {
  it("explains what a job is rather than showing an empty box", async () => {
    show();
    expect(await screen.findByText(/backup, a fetch, a digest/i)).toBeTruthy();
  });

  it("settles into a usable state when the read fails", async () => {
    // A spinner forever is the wrong answer: the panel has to reach a state
    // somebody can act from even when the list could not be loaded.
    listJobs.mockRejectedValue(new Error("Could not load the jobs"));
    show();

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Could not load the jobs");
    });
    expect(await screen.findByLabelText("Add a job")).toBeTruthy();
  });
});

describe("listing jobs", () => {
  it("shows the command, the schedule and when it next runs", async () => {
    listJobs.mockResolvedValue([NIGHTLY]);
    show();

    expect(await screen.findByText("Nightly backup")).toBeTruthy();
    expect(screen.getByText("npm run backup")).toBeTruthy();
    expect(screen.getByText("0 3 * * *")).toBeTruthy();
    expect(screen.getByText(/next in 2h/)).toBeTruthy();
  });

  it("says paused rather than a next run for a disabled job", async () => {
    // A disabled job has no next run rather than one it is going to miss, and
    // showing a time for it would say the opposite.
    listJobs.mockResolvedValue([{ ...NIGHTLY, enabled: false, nextRunAt: null }]);
    show();

    expect(await screen.findByText("paused")).toBeTruthy();
  });

  it("shows the last outcome, including the ones that are not failures", async () => {
    // SKIPPED, TIMED_OUT and ERRORED are three different problems with three
    // different fixes, and collapsing them into "failed" sends people to read
    // the wrong logs.
    listJobs.mockResolvedValue([
      { ...NIGHTLY, id: "a", name: "A", lastRun: run("SUCCEEDED") },
      { ...NIGHTLY, id: "b", name: "B", lastRun: run("FAILED", 1) },
      { ...NIGHTLY, id: "c", name: "C", lastRun: run("SKIPPED") },
      { ...NIGHTLY, id: "d", name: "D", lastRun: run("TIMED_OUT") },
      { ...NIGHTLY, id: "e", name: "E", lastRun: run("ERRORED") },
    ]);
    show();

    expect(await screen.findByText("ok")).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.getByText("skipped")).toBeTruthy();
    expect(screen.getByText("timed out")).toBeTruthy();
    expect(screen.getByText("could not start")).toBeTruthy();
  });

  it("shows output only when there is some", async () => {
    listJobs.mockResolvedValue([
      { ...NIGHTLY, lastRun: { ...run("SUCCEEDED"), output: null } },
    ]);
    const { unmount } = show();

    // An empty <pre> implies output was lost rather than never produced.
    await screen.findByText("Nightly backup");
    expect(screen.queryByLabelText("Nightly backup output")).toBeNull();
    unmount();

    listJobs.mockResolvedValue([
      { ...NIGHTLY, lastRun: { ...run("FAILED", 1), output: "boom" } },
    ]);
    show();
    expect(await screen.findByLabelText("Nightly backup output")).toBeTruthy();
  });
});

describe("changing what runs", () => {
  it("creates a job from the form, trimmed", async () => {
    show();

    fireEvent.click(await screen.findByLabelText("Add a job"));
    fireEvent.change(screen.getByLabelText("Job name"), {
      target: { value: "  Nightly backup  " },
    });
    fireEvent.change(screen.getByLabelText("Schedule"), {
      target: { value: " 0 3 * * * " },
    });
    fireEvent.change(screen.getByLabelText("Command"), {
      target: { value: " npm run backup " },
    });
    fireEvent.click(screen.getByText("Save").closest("button")!);

    await waitFor(() => {
      expect(createJob).toHaveBeenCalledWith("p1", {
        name: "Nightly backup",
        schedule: "0 3 * * *",
        command: "npm run backup",
      });
    });
  });

  it("keeps the server's reason when a schedule is refused", async () => {
    // "A job may run at most once every 5 minutes" tells somebody what to type
    // next. "Something went wrong" does not.
    createJob.mockRejectedValue(
      new Error("A job may run at most once every 5 minutes."),
    );
    show();

    fireEvent.click(await screen.findByLabelText("Add a job"));
    for (const [label, value] of [
      ["Job name", "Too often"],
      ["Schedule", "* * * * *"],
      ["Command", "echo hi"],
    ]) {
      fireEvent.change(screen.getByLabelText(label!), {
        target: { value: value! },
      });
    }
    fireEvent.click(screen.getByText("Save").closest("button")!);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "A job may run at most once every 5 minutes.",
      );
    });
  });

  it("pauses and resumes without deleting", async () => {
    listJobs.mockResolvedValue([NIGHTLY]);
    show();

    fireEvent.click(await screen.findByLabelText("Pause Nightly backup"));

    await waitFor(() => {
      expect(updateJob).toHaveBeenCalledWith("p1", "j1", { enabled: false });
    });
    expect(deleteJob).not.toHaveBeenCalled();
  });

  it("runs one now, outside its schedule", async () => {
    listJobs.mockResolvedValue([NIGHTLY]);
    show();

    fireEvent.click(await screen.findByLabelText("Run Nightly backup now"));

    await waitFor(() => {
      expect(runJob).toHaveBeenCalledWith("p1", "j1");
    });
  });
});

describe("a collaborator who is not the owner", () => {
  it("can read the jobs and cannot change them", async () => {
    // Reading is a viewer's; arranging for a command to run at 3am forever is
    // not the same grant as being able to edit a file.
    listJobs.mockResolvedValue([NIGHTLY]);
    show(false);

    expect(await screen.findByText("Nightly backup")).toBeTruthy();
    expect(screen.queryByLabelText("Add a job")).toBeNull();
    expect(screen.queryByLabelText("Pause Nightly backup")).toBeNull();
    expect(screen.queryByLabelText("Delete Nightly backup")).toBeNull();
  });
});

function run(status: string, exitCode: number | null = 0) {
  return {
    id: `r-${status}`,
    startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    finishedAt: new Date(Date.now() - 29 * 60_000).toISOString(),
    status,
    exitCode,
    output: null,
  } as ScheduledJob["lastRun"];
}
