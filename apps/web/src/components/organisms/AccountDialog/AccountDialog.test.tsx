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
      idleMinutes: 20,
      managedDatabases: true,
      customDomains: true,
      scheduledJobs: true,
      devcontainerMounts: false,
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
    // Null is the normal case, and the one every account on a deployment with
    // no payment processor is in.
    subscription: null,
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
            idleMinutes: 20,
            managedDatabases: true,
            customDomains: true,
            scheduledJobs: true,
            devcontainerMounts: false,
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
          { id: "free", label: "Free", priceCents: 0, currency: "usd", rank: 0, maxProjects: base.maxProjects, userDiskQuotaMb: base.userDiskQuotaMb, projectDiskQuotaMb: base.projectDiskQuotaMb, aiRequestsPerHour: base.aiRequestsPerHour, maxContainersPerUser: base.maxContainersPerUser, idleMinutes: base.idleMinutes, managedDatabases: true, customDomains: true, scheduledJobs: true , devcontainerMounts: false },
          { id: "pro", label: "Pro", priceCents: 1200, currency: "usd", rank: 1, maxProjects: 100, userDiskQuotaMb: 20480, projectDiskQuotaMb: 2048, aiRequestsPerHour: 500, maxContainersPerUser: 3, idleMinutes: 60, managedDatabases: true, customDomains: true, scheduledJobs: true , devcontainerMounts: false },
        ],
      }),
    );
    show();

    expect(await screen.findByText("Current")).toBeTruthy();
    expect(screen.getByText(/12\.00 USD/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /upgrade/i })).toBeNull();
  });

  /** How long a workspace survives unattended is a promise about the user's
   *  work rather than an amount of it — "your dev server was stopped while you
   *  were at lunch" should be readable beforehand rather than discovered. */
  it("says how long a workspace survives with nobody looking at it", async () => {
    const base = summary().entitlements;
    getAccount.mockResolvedValue(
      summary({
        plans: [
          { id: "free", label: "Free", priceCents: 0, currency: "usd", rank: 0, maxProjects: base.maxProjects, userDiskQuotaMb: base.userDiskQuotaMb, projectDiskQuotaMb: base.projectDiskQuotaMb, aiRequestsPerHour: base.aiRequestsPerHour, maxContainersPerUser: base.maxContainersPerUser, idleMinutes: 20, managedDatabases: true, customDomains: true, scheduledJobs: true , devcontainerMounts: false },
          { id: "pro", label: "Pro", priceCents: 1200, currency: "usd", rank: 1, maxProjects: 100, userDiskQuotaMb: 20480, projectDiskQuotaMb: 2048, aiRequestsPerHour: 500, maxContainersPerUser: 3, idleMinutes: 60, managedDatabases: true, customDomains: true, scheduledJobs: true , devcontainerMounts: false },
        ],
      }),
    );
    show();

    expect(await screen.findByText(/Sleeps after 20 minutes/)).toBeTruthy();
    // Read as hours once it divides, because "60 minutes" is a number nobody
    // says out loud.
    expect(screen.getByText(/Sleeps after 1 hour/)).toBeTruthy();
  });

  /** The personal plan's whole point: idleness alone is not a reason to stop
   *  somebody's dev server. It is deliberately NOT called "runs forever" —
   *  the machine still reclaims the least recently used workspace when it is
   *  out of room. */
  it("says a plan that never sleeps, without promising it runs forever", async () => {
    const base = summary().entitlements;
    getAccount.mockResolvedValue(
      summary({
        plans: [
          { id: "free", label: "Free", priceCents: 0, currency: "usd", rank: 0, maxProjects: base.maxProjects, userDiskQuotaMb: base.userDiskQuotaMb, projectDiskQuotaMb: base.projectDiskQuotaMb, aiRequestsPerHour: base.aiRequestsPerHour, maxContainersPerUser: base.maxContainersPerUser, idleMinutes: 20, managedDatabases: true, customDomains: true, scheduledJobs: true , devcontainerMounts: false },
          // The catalogue is only drawn when there is more than one plan to
          // choose between, so the personal plan needs something to sit beside.
          { id: "personal", label: "Personal", priceCents: 0, currency: "usd", rank: 100, maxProjects: 0, userDiskQuotaMb: 0, projectDiskQuotaMb: 0, aiRequestsPerHour: 0, maxContainersPerUser: 0, idleMinutes: 0, managedDatabases: true, customDomains: true, scheduledJobs: true , devcontainerMounts: false },
        ],
      }),
    );
    show();

    expect(await screen.findByText(/Never sleeps/)).toBeTruthy();
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

describe("the subscription", () => {
  const DAY = 86_400_000;

  function subscribed(over: Partial<NonNullable<AccountSummary["subscription"]>> = {}) {
    return summary({
      subscription: {
        status: "ACTIVE",
        planId: "pro",
        planLabel: "Pro",
        currentPeriodEnd: new Date(Date.now() + 20 * DAY).toISOString(),
        graceUntil: null,
        entitled: true,
        ...over,
      },
    });
  }

  /** Every account on a deployment with no payment processor. A screen that
   *  said something about billing here would be inventing a relationship. */
  it("says nothing at all when there is not one", async () => {
    show();

    await screen.findByText(/someone@example.com/);
    expect(screen.queryByText(/subscription/i)).toBeNull();
  });

  /** A renewal that works is not news -- decision 14 on a screen. */
  it("is a quiet line when it is simply paid up", async () => {
    getAccount.mockResolvedValue(subscribed());
    show();

    await screen.findByText(/renews/i);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /** The two things somebody can act on: nothing has happened yet, and when
   *  it will. */
  it("warns about a failed payment, with the date attached", async () => {
    const graceUntil = new Date(Date.now() + 3 * DAY);
    getAccount.mockResolvedValue(
      subscribed({ status: "PAST_DUE", graceUntil: graceUntil.toISOString() }),
    );
    show();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/did not go through/i);
    // The date is the actionable half. Without it the banner is only anxiety.
    expect(alert.textContent).toContain(graceUntil.toLocaleDateString());
    expect(alert.textContent).toMatch(/nothing is deleted/i);
  });

  /** The message that would be easiest to get wrong and would cost the most.
   *  What a person fears at this moment is that their work is gone. */
  it("says plainly that an ended subscription took nothing away", async () => {
    getAccount.mockResolvedValue(
      subscribed({ status: "CANCELED", entitled: false, currentPeriodEnd: null }),
    );
    show();

    expect(await screen.findByText(/still here/i)).toBeTruthy();
    expect(screen.getByText(/still running/i)).toBeTruthy();
  });

  /** Past due AND past the grace is the same situation as cancelled, and must
   *  not show the "nothing has changed yet" banner -- by then it has. */
  it("does not promise a grace that has already run out", async () => {
    getAccount.mockResolvedValue(
      subscribed({
        status: "PAST_DUE",
        entitled: false,
        graceUntil: new Date(Date.now() - DAY).toISOString(),
      }),
    );
    show();

    expect(await screen.findByText(/still here/i)).toBeTruthy();
    expect(screen.queryByText(/nothing has changed yet/i)).toBeNull();
  });
});
