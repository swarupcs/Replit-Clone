// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MachineStatus } from "@replit-clone/shared";

const getStatus = vi.fn();

vi.mock("../../../apis/projects.ts", () => ({
  getMachineStatusApi: () => getStatus() as unknown,
}));

import { MachinePanel } from "./MachinePanel.tsx";

function status(over: Partial<MachineStatus> = {}): MachineStatus {
  return {
    containersRunning: 1,
    containerLimit: 3,
    backup: {
      enabled: true,
      destination: "/backups",
      lastRunAt: Date.UTC(2026, 8, 9, 3, 0),
      lastRunOk: true,
      lastError: null,
      backedUp: 4,
    },
    runningJobRuns: 0,
    uptimeSeconds: 7200,
    memoryBytes: 180 * 1024 * 1024,
    counters: { jobs_started: 4, deploys_failed: 1 },
    ...over,
  };
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <MachinePanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getStatus.mockReset().mockResolvedValue(status());
});

afterEach(cleanup);

/** "Is this machine full" is the question a three-container cap makes an
 *  operator ask most often, and no screen could answer it until now. */
describe("capacity", () => {
  it("says what is running against what is allowed", async () => {
    show();

    expect(await screen.findByText("1 of 3")).toBeTruthy();
    expect(screen.getByText(/room to start another/i)).toBeTruthy();
  });

  it("says plainly when the next project will be refused", async () => {
    getStatus.mockResolvedValue(status({ containersRunning: 3 }));
    show();

    expect(await screen.findByText(/at capacity/i)).toBeTruthy();
  });
});

/** This number is not a gauge but a defect report: a scheduled run should
 *  leave RUNNING, and one that does not is §3.1's restart wedge, which is
 *  otherwise completely silent. */
describe("scheduled runs in progress", () => {
  it("is not mentioned when there are none", async () => {
    show();

    await screen.findByText("1 of 3");
    expect(screen.queryByText(/in progress/i)).toBeNull();
  });

  it("says what it means when the number does not come back down", async () => {
    getStatus.mockResolvedValue(status({ runningJobRuns: 3 }));
    show();

    expect(await screen.findByText(/3 scheduled runs are in progress/i)).toBeTruthy();
    expect(screen.getByText(/report SKIPPED from then on/i)).toBeTruthy();
  });
});

describe("the counters", () => {
  it("are listed, and said to be this process's own", async () => {
    show();

    expect(await screen.findByText("jobs_started")).toBeTruthy();
    expect(screen.getByText("deploys_failed")).toBeTruthy();
    expect(screen.getByText(/reset when the server restarts/i)).toBeTruthy();
  });

  it("say so when nothing has happened yet", async () => {
    getStatus.mockResolvedValue(status({ counters: {} }));
    show();

    expect(
      await screen.findByText(/nothing has happened since this server started/i),
    ).toBeTruthy();
  });

  it("does not render a refusal as an idle machine", async () => {
    getStatus.mockRejectedValue(new Error("403"));
    show();

    expect(
      await screen.findByText(/could not load the machine's status/i),
    ).toBeTruthy();
  });
});

/** plan.md §3.3. The panel's job here is narrower than it looks: an operator
 *  glancing at this screen has to be able to tell "backed up" from "switched
 *  on and silent", and those two look identical everywhere else. */
describe("the backup readout", () => {
  it("warns, rather than reporting a number, when backups are off", async () => {
    getStatus.mockResolvedValue(
      status({
        backup: {
          enabled: false,
          destination: null,
          lastRunAt: null,
          lastRunOk: null,
          lastError: null,
          backedUp: null,
        },
      }),
    );

    show();

    // Not a statistic. It is the single fact about this machine most likely to
    // matter and least likely to be noticed.
    expect(await screen.findByText("Backups are off")).toBeTruthy();
  });

  it("says how many projects the last sweep copied, and where", async () => {
    show();

    expect(await screen.findByText(/Backed up 4 projects/)).toBeTruthy();
    expect(screen.getByText(/\/backups/)).toBeTruthy();
  });

  it("does not report a green tick for a run that has never happened", async () => {
    getStatus.mockResolvedValue(
      status({
        backup: {
          enabled: true,
          destination: "/backups",
          lastRunAt: null,
          lastRunOk: null,
          lastError: null,
          backedUp: null,
        },
      }),
    );

    show();

    // Configured and silent is the exact shape of broken, and a tick would
    // hide it.
    expect(
      await screen.findByText(/have not run yet in this process/),
    ).toBeTruthy();
  });

  it("surfaces the reason when a sweep had failures", async () => {
    getStatus.mockResolvedValue(
      status({
        backup: {
          enabled: true,
          destination: "/backups",
          lastRunAt: Date.UTC(2026, 8, 9, 3, 0),
          lastRunOk: false,
          lastError: "2 project(s) could not be backed up",
          backedUp: 2,
        },
      }),
    );

    show();

    expect(await screen.findByText(/Last backup had failures/)).toBeTruthy();
    expect(screen.getByText(/could not be backed up/)).toBeTruthy();
  });
});
