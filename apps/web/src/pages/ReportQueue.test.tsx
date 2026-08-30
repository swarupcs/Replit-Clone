// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ProjectReport } from "@replit-clone/shared";

const listReports = vi.fn();
const reviewReport = vi.fn();

vi.mock("../apis/projects.ts", () => ({
  listReportsApi: (status: string) => listReports(status) as unknown,
  reviewReportApi: (id: string, decision: string) =>
    reviewReport(id, decision) as unknown,
}));

import { ReportQueue } from "./ReportQueue.tsx";

function report(over: Partial<ProjectReport> = {}): ProjectReport {
  return {
    id: "r1",
    projectId: "p1",
    projectName: "Leaky App",
    ownerEmail: "owner@example.com",
    reason: "SECRETS",
    details: "AWS key in .env",
    status: "OPEN",
    reporterEmail: "reporter@example.com",
    createdAt: "2026-08-29T10:00:00.000Z",
    reviewedAt: null,
    reviewedBy: null,
    ...over,
  };
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ReportQueue />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listReports.mockReset();
  reviewReport.mockReset();
  listReports.mockResolvedValue([report()]);
  reviewReport.mockResolvedValue(report({ status: "ACTIONED" }));
});

afterEach(() => {
  cleanup();
});

describe("what the queue shows", () => {
  it("asks for the open reports first", async () => {
    show();

    await waitFor(() => {
      expect(listReports).toHaveBeenCalledWith("OPEN");
    });
  });

  it("names the project, its owner, and who reported it", async () => {
    show();

    expect(await screen.findByText("Leaky App")).toBeTruthy();
    expect(screen.getByText(/owner@example\.com/)).toBeTruthy();
    expect(screen.getByText(/reporter@example\.com/)).toBeTruthy();
    expect(screen.getByText("AWS key in .env")).toBeTruthy();
  });

  /** The report outlives the account that filed it and stops naming them.
   *  Rendering that as an empty gap would read as a bug rather than as the
   *  deliberate thing it is. */
  it("says so when the reporter has deleted their account", async () => {
    listReports.mockResolvedValue([report({ reporterEmail: null })]);
    show();

    expect(await screen.findByText(/a deleted account/)).toBeTruthy();
  });

  /** The only two decisions an operator has. Anything that looked like a
   *  third — delete, suspend, edit — would be an authority this surface
   *  deliberately does not grant. */
  it("offers exactly two decisions on an open report", async () => {
    show();

    expect(await screen.findByRole("button", { name: "Make private" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /suspend/i })).toBeNull();
  });

  it("offers no decisions on one already reviewed", async () => {
    listReports.mockResolvedValue([
      report({
        status: "ACTIONED",
        reviewedBy: "ops@example.com",
        reviewedAt: "2026-08-29T12:00:00.000Z",
      }),
    ]);
    show();

    expect(await screen.findByText(/Reviewed by ops@example\.com/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make private" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  /** Everybody not on the allowlist gets a 403, including anybody who simply
   *  typed the URL. The page has to survive that as an ordinary outcome. */
  it("says the queue could not be loaded rather than breaking", async () => {
    listReports.mockRejectedValue({ response: { status: 403 } });
    show();

    expect(
      await screen.findByText(/may not be able to review reports/),
    ).toBeTruthy();
  });

  it("says when there is nothing to review", async () => {
    listReports.mockResolvedValue([]);
    show();

    expect(await screen.findByText("Nothing to review.")).toBeTruthy();
  });
});

describe("acting on one", () => {
  it("actions a report", async () => {
    show();

    fireEvent.click(await screen.findByRole("button", { name: "Make private" }));

    await waitFor(() => {
      expect(reviewReport).toHaveBeenCalledWith("r1", "ACTIONED");
    });
  });

  it("dismisses a report", async () => {
    show();

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));

    await waitFor(() => {
      expect(reviewReport).toHaveBeenCalledWith("r1", "DISMISSED");
    });
  });

  /** The two buttons sit next to each other and one of them un-publishes
   *  somebody's work. Sending the wrong decision would be invisible from the
   *  interface and irreversible from the operator's side. */
  it("does not send the other decision", async () => {
    show();

    fireEvent.click(await screen.findByRole("button", { name: "Make private" }));

    await waitFor(() => {
      expect(reviewReport).toHaveBeenCalledTimes(1);
    });
    expect(reviewReport).not.toHaveBeenCalledWith("r1", "DISMISSED");
  });

  it("re-reads the queue once a decision lands", async () => {
    show();
    const dismiss = await screen.findByRole("button", { name: "Dismiss" });
    expect(listReports).toHaveBeenCalledTimes(1);

    fireEvent.click(dismiss);

    await waitFor(() => {
      expect(listReports.mock.calls.length).toBeGreaterThan(1);
    });
  });
});

describe("the filter", () => {
  it("asks the server for the slice that was chosen", async () => {
    show();
    await screen.findByText("Leaky App");

    fireEvent.click(screen.getByText("Actioned"));

    await waitFor(() => {
      expect(listReports).toHaveBeenCalledWith("ACTIONED");
    });
  });
});
