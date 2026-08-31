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
import type { AccountDetail, AccountRow } from "@replit-clone/shared";

const search = vi.fn();
const getAccount = vi.fn();
const setPlan = vi.fn();
const setOverride = vi.fn();

vi.mock("../../../apis/projects.ts", () => ({
  searchAccountsApi: (q: string) => search(q) as unknown,
  getAdminAccountApi: (id: string) => getAccount(id) as unknown,
  setAccountPlanApi: (id: string, planId: string, reason: string) =>
    setPlan(id, planId, reason) as unknown,
  setAccountOverrideApi: (input: unknown) => setOverride(input) as unknown,
}));

import { AccountAdmin } from "./AccountAdmin.tsx";

const USER = "11111111-1111-4111-8111-111111111111";

function row(over: Partial<AccountRow> = {}): AccountRow {
  return {
    userId: USER,
    email: "someone@example.com",
    createdAt: "2026-08-01T09:00:00.000Z",
    planId: "free",
    planLabel: "Free",
    projects: 3,
    overridden: false,
    ...over,
  };
}

function plan(id: string, label: string) {
  return {
    id,
    label,
    priceCents: id === "free" ? 0 : 1200,
    currency: "usd",
    rank: id === "free" ? 0 : 1,
    maxProjects: 20,
    userDiskQuotaMb: 2048,
    projectDiskQuotaMb: 512,
    aiRequestsPerHour: 60,
    maxContainersPerUser: 2,
    managedDatabases: true,
    customDomains: true,
    scheduledJobs: true,
  };
}

function detail(over: Partial<AccountDetail> = {}): AccountDetail {
  return {
    userId: USER,
    email: "someone@example.com",
    createdAt: "2026-08-01T09:00:00.000Z",
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
    diskBytes: 100 * 1024 * 1024,
    actions: [],
    plans: [plan("free", "Free"), plan("pro", "Pro")],
    ...over,
  };
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <AccountAdmin />
    </QueryClientProvider>,
  );
}

/** Opens the first result, which every case below starts from. */
async function open() {
  show();
  fireEvent.click(await screen.findByRole("button", { name: /open/i }));
  return screen.findByText(/joined/i);
}

beforeEach(() => {
  search.mockReset().mockResolvedValue([row()]);
  getAccount.mockReset().mockResolvedValue(detail());
  setPlan.mockReset().mockResolvedValue({ id: "a1" });
  setOverride.mockReset().mockResolvedValue({ id: "a1" });
});

afterEach(cleanup);

describe("finding an account", () => {
  it("lists what matches, with the plan and whether it was adjusted", async () => {
    search.mockResolvedValue([row({ overridden: true })]);
    show();

    expect(await screen.findByText("someone@example.com")).toBeTruthy();
    expect(screen.getByText("Free")).toBeTruthy();
    expect(screen.getByText(/hand-set limits/i)).toBeTruthy();
  });

  it("says so when nothing matches", async () => {
    search.mockResolvedValue([]);
    show();

    expect(await screen.findByText(/no accounts match/i)).toBeTruthy();
  });

  it("does not render a refusal as an empty result", async () => {
    search.mockRejectedValue(new Error("403"));
    show();

    expect(await screen.findByText(/could not search accounts/i)).toBeTruthy();
  });
});

/** §6 decision 11: the moderation authority is small because nothing reviews
 *  it. This is the first power that acts on a person, so nothing here happens
 *  without a reason attached to it. */
describe("changing what an account is allowed", () => {
  it("will not change a plan until a reason is written", async () => {
    await open();

    const change = screen.getByRole("button", { name: /change plan/i });
    expect(change.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Why"), {
      target: { value: "They asked, and paid." },
    });
    // A reason is necessary and not sufficient: a plan still has to be picked.
    expect(change.hasAttribute("disabled")).toBe(true);
  });

  it("sends the reason with the change", async () => {
    await open();

    fireEvent.change(screen.getByLabelText("Why"), {
      target: { value: "  Comped for the beta.  " },
    });

    // antd's Select is not a native <select>; picking through the listbox is
    // what a person does and what this asserts.
    fireEvent.mouseDown(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByTitle("Pro"));
    fireEvent.click(screen.getByRole("button", { name: /change plan/i }));

    await waitFor(() => {
      expect(setPlan).toHaveBeenCalledWith(USER, "pro", "Comped for the beta.");
    });
  });

  /** Moving somebody to the plan they are on is refused by the server, so
   *  offering it would be offering a refusal. */
  it("does not offer the plan the account is already on", async () => {
    await open();

    fireEvent.mouseDown(screen.getByRole("combobox"));

    expect(await screen.findByTitle("Pro")).toBeTruthy();
    expect(screen.queryByTitle("Free")).toBeNull();
  });

  it("offers to clear hand-set limits only when there are some", async () => {
    await open();
    expect(screen.queryByRole("button", { name: /clear hand-set/i })).toBeNull();

    cleanup();
    getAccount.mockResolvedValue(
      detail({
        entitlements: { ...detail().entitlements, overridden: true },
      }),
    );
    await open();

    expect(screen.getByRole("button", { name: /clear hand-set/i })).toBeTruthy();
    expect(screen.getByText(/do not expire/i)).toBeTruthy();
  });

  it("sends a clear as an override of null", async () => {
    getAccount.mockResolvedValue(
      detail({
        entitlements: { ...detail().entitlements, overridden: true },
      }),
    );
    await open();

    fireEvent.change(screen.getByLabelText("Why"), {
      target: { value: "Trial over." },
    });
    fireEvent.click(screen.getByRole("button", { name: /clear hand-set/i }));

    await waitFor(() => {
      expect(setOverride).toHaveBeenCalledWith({
        userId: USER,
        override: null,
        reason: "Trial over.",
      });
    });
  });

  /** The operator is told, on the screen, that the person will be told. A
   *  power exercised on somebody should not feel private to the one using it. */
  it("says that the account holder reads the reason", async () => {
    await open();

    expect(screen.getByText(/the account holder is told/i)).toBeTruthy();
  });
});

describe("what has been done to an account", () => {
  it("shows the trail, with who did it and why", async () => {
    getAccount.mockResolvedValue(
      detail({
        actions: [
          {
            id: "a1",
            subjectUserId: USER,
            subjectEmail: "someone@example.com",
            action: "PLAN_CHANGED",
            actor: "operator@example.com",
            reason: "Comped for the beta.",
            detail: "Free to Pro",
            createdAt: "2026-08-31T09:00:00.000Z",
          },
        ],
      }),
    );
    await open();

    expect(screen.getByText("Plan changed")).toBeTruthy();
    expect(screen.getByText("Free to Pro")).toBeTruthy();
    expect(screen.getByText("Comped for the beta.")).toBeTruthy();
    expect(screen.getByText(/operator@example\.com/)).toBeTruthy();
  });

  it("says so when nobody has changed it", async () => {
    await open();

    expect(screen.getByText(/nobody has changed this account/i)).toBeTruthy();
  });
});
