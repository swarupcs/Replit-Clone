// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AccountSummary } from "@replit-clone/shared";

const getAccount = vi.fn();

vi.mock("../../../apis/projects.ts", () => ({
  getAccountApi: () => getAccount() as unknown,
}));

import { AccountDialog } from "./AccountDialog.tsx";

const MB = 1024 * 1024;

function summary(over: Partial<AccountSummary> = {}): AccountSummary {
  return {
    email: "someone@example.com",
    entitlements: {
      planId: "free",
      planLabel: "Free",
      maxProjects: 20,
      userDiskQuotaMb: 2048,
      projectDiskQuotaMb: 512,
      aiRequestsPerHour: 60,
      maxContainersPerUser: 2,
      managedDatabases: true,
      customDomains: true,
      scheduledJobs: true,
      overridden: false,
      overrideUntil: null,
    },
    projects: 3,
    diskBytes: 400 * MB,
    breakdown: [
      { projectId: "p1", name: "Big One", diskBytes: 380 * MB },
      { projectId: "p2", name: "Small One", diskBytes: 20 * MB },
    ],
    plans: [],
    // Three and a bit hours, so the reading below is not a round number that
    // a broken formatter could produce by accident.
    computeSecondsThisMonth: 11_400,
    ...over,
  };
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <AccountDialog open onClose={() => undefined} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getAccount.mockReset().mockResolvedValue(summary());
});

afterEach(cleanup);

describe("what this account is using", () => {
  it("shows each number against its limit, not on its own", async () => {
    show();

    expect(await screen.findByText("3 of 20")).toBeTruthy();
    expect(screen.getByText(/400 MB of 2\.0 GB/)).toBeTruthy();
  });

  /** The half that makes a quota actionable. Largest first, because the
   *  question somebody opens this with is "what do I delete". */
  it("names which project is responsible, largest first", async () => {
    show();

    const listed = await screen.findByLabelText("Storage by project");
    expect(listed.textContent).toContain("Big One");
    expect(listed.textContent?.indexOf("Big One")).toBeLessThan(
      listed.textContent?.indexOf("Small One") ?? 0,
    );
  });

  it("says which plan it is on", async () => {
    show();

    expect(await screen.findByText("Free")).toBeTruthy();
  });

  /** A limit that appears on no pricing page should say why it is different
   *  rather than read as a bug. */
  it("says when the limits were adjusted by hand", async () => {
    getAccount.mockResolvedValue(
      summary({
        entitlements: {
          ...summary().entitlements,
          overridden: true,
          overrideUntil: null,
        },
      }),
    );
    show();

    expect(await screen.findByText(/adjusted for this account/i)).toBeTruthy();
  });

  it("does not say that when they were not", async () => {
    show();

    await screen.findByText("3 of 20");
    expect(screen.queryByText(/adjusted for this account/i)).toBeNull();
  });

  it("says so for an account with nothing in it", async () => {
    getAccount.mockResolvedValue(
      summary({ projects: 0, diskBytes: 0, breakdown: [] }),
    );
    show();

    expect(await screen.findByText(/nothing here yet/i)).toBeTruthy();
  });

  it("does not render a failure as an empty account", async () => {
    getAccount.mockRejectedValue(new Error("500"));
    show();

    expect(
      await screen.findByText(/could not load this account's usage/i),
    ).toBeTruthy();
  });
});

describe("the catalogue", () => {
  /** One plan is not a choice, so offering it as one would be theatre. */
  it("is not shown when there is only one plan", async () => {
    getAccount.mockResolvedValue(
      summary({
        plans: [
          {
            id: "free",
            label: "Free",
            priceCents: 0,
            currency: "usd",
            rank: 0,
            maxProjects: 20,
            userDiskQuotaMb: 2048,
            projectDiskQuotaMb: 512,
            aiRequestsPerHour: 60,
            maxContainersPerUser: 2,
            managedDatabases: true,
            customDomains: true,
            scheduledJobs: true,
          },
        ],
      }),
    );
    show();

    await screen.findByText("3 of 20");
    expect(screen.queryByLabelText("Plans")).toBeNull();
  });

  /** Nothing here takes payment yet, and a button that appeared to would be
   *  lying about what happens next. */
  it("marks the current plan and offers no way to change it", async () => {
    const base = summary().entitlements;
    getAccount.mockResolvedValue(
      summary({
        plans: [
          { id: "free", label: "Free", priceCents: 0, currency: "usd", rank: 0, maxProjects: base.maxProjects, userDiskQuotaMb: base.userDiskQuotaMb, projectDiskQuotaMb: base.projectDiskQuotaMb, aiRequestsPerHour: base.aiRequestsPerHour, maxContainersPerUser: base.maxContainersPerUser, managedDatabases: true, customDomains: true, scheduledJobs: true },
          { id: "pro", label: "Pro", priceCents: 1200, currency: "usd", rank: 1, maxProjects: 100, userDiskQuotaMb: 20480, projectDiskQuotaMb: 2048, aiRequestsPerHour: 500, maxContainersPerUser: 3, managedDatabases: true, customDomains: true, scheduledJobs: true },
        ],
      }),
    );
    show();

    expect(await screen.findByText("Current")).toBeTruthy();
    expect(screen.getByText(/12\.00 USD/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /upgrade/i })).toBeNull();
  });
});

/** Compute is what this platform actually spends, and until now nothing
 *  counted it. plan.md 8.8 asks whether this product sells capability or sells
 *  minutes; the number exists so that question has data behind it, and it is
 *  shown without being charged for while the answer is open. */
describe("compute", () => {
  it("reads it in hours, and says it is not a bill", async () => {
    show();

    expect(await screen.findByText(/3.2 hours/)).toBeTruthy();
    expect(screen.getByText(/not charged for/i)).toBeTruthy();
  });

  it("says minutes when it is minutes", async () => {
    // The first month of a free tier is all minutes, and "0.1 hours" is a
    // number nobody pictures.
    getAccount.mockResolvedValue(summary({ computeSecondsThisMonth: 300 }));
    show();

    expect(await screen.findByText(/5 minutes/)).toBeTruthy();
  });

  it("says none rather than zero", async () => {
    getAccount.mockResolvedValue(summary({ computeSecondsThisMonth: 0 }));
    show();

    expect(await screen.findByText(/none yet/i)).toBeTruthy();
  });

  /** A bar needs a limit and there is no limit on this. Rendering one would
   *  answer the pricing question by accident. */
  it("is not shown as a quota bar", async () => {
    show();

    await screen.findByText(/3.2 hours/);
    expect(screen.queryByLabelText(/compute/i)).toBeNull();
  });
});
