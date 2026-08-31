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
import type { ModerationAction } from "@replit-clone/shared";

const listRecent = vi.fn();
const reinstate = vi.fn();

/** The endpoint is paged. Array fixtures below are wrapped into a single
 *  complete page; a test that cares about paging returns a real one. */
function asPage(value: unknown): unknown {
  return Array.isArray(value) ? { items: value, nextCursor: null } : value;
}

vi.mock("../../../apis/projects.ts", () => ({
  listRecentModerationApi: async (cursor?: string) =>
    asPage(await (listRecent(cursor) as Promise<unknown>)),
  reinstateProjectApi: (id: string, reason: string) =>
    reinstate(id, reason) as unknown,
}));

import { ModerationActivity } from "./ModerationActivity.tsx";

function action(over: Partial<ModerationAction> = {}): ModerationAction {
  return {
    id: "a1",
    projectId: "p1",
    projectName: "Leaky App",
    reportId: "r1",
    action: "ACTIONED",
    actor: "mod@example.com",
    reason: null,
    createdAt: "2026-08-30T09:00:00.000Z",
    ...over,
  };
}

/** The API returns newest first, and `unansweredAppeals` reads it in that
 *  order. A fixture in the wrong order would test a different function. */
function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <ModerationActivity />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listRecent.mockReset().mockResolvedValue([]);
  reinstate.mockReset().mockResolvedValue(action({ action: "REINSTATED" }));
});

afterEach(cleanup);

/** Until this existed the queue showed the case that arrived and nothing
 *  afterwards, so an appeal could be filed and never read. */
describe("an appeal nobody has answered", () => {
  const appealed = [
    action({ id: "a2", action: "APPEALED", actor: "owner@example.com", createdAt: "2026-08-30T10:00:00.000Z", reason: "The key was rotated." }),
    action({ id: "a1" }),
  ];

  it("is marked as waiting, and offers the one action that undoes a takedown", async () => {
    listRecent.mockResolvedValue(appealed);
    show();

    expect(await screen.findByText(/waiting on you/i)).toBeTruthy();
    expect(screen.getByText("The key was rotated.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /put it back/i })).toBeTruthy();
  });

  it("requires a reason before it can be answered", async () => {
    listRecent.mockResolvedValue(appealed);
    show();

    fireEvent.click(await screen.findByRole("button", { name: /put it back/i }));

    const confirm = screen
      .getAllByRole("button", { name: /put it back/i })
      .find((button) => button.classList.contains("ant-btn-primary"));

    // Of every action here it is the one an operator has most reason to leave
    // unexplained, which is why the server requires it and so does this.
    expect(confirm?.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Why you are putting it back"), {
      target: { value: "  Reporter withdrew it.  " },
    });
    expect(confirm?.hasAttribute("disabled")).toBe(false);

    fireEvent.click(confirm!);

    await waitFor(() => {
      expect(reinstate).toHaveBeenCalledWith("p1", "Reporter withdrew it.");
    });
  });
});

describe("an appeal already answered", () => {
  /** A reinstatement after the appeal closes it. Newest first, so the
   *  reinstatement is seen before the appeal it answers. */
  it("is not still asking for an answer", async () => {
    listRecent.mockResolvedValue([
      action({ id: "a3", action: "REINSTATED", createdAt: "2026-08-30T11:00:00.000Z", reason: "Fair enough." }),
      action({ id: "a2", action: "APPEALED", createdAt: "2026-08-30T10:00:00.000Z" }),
      action({ id: "a1" }),
    ]);
    show();

    expect(await screen.findByText("Fair enough.")).toBeTruthy();
    expect(screen.queryByText(/waiting on you/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /put it back/i })).toBeNull();
  });

  /** Two projects, one answered and one not. A version that tracked a single
   *  flag rather than a set per project would get this backwards. */
  it("does not answer for another project", async () => {
    listRecent.mockResolvedValue([
      action({ id: "b3", projectId: "p2", projectName: "Other App", action: "REINSTATED", createdAt: "2026-08-30T12:00:00.000Z" }),
      action({ id: "b2", projectId: "p2", projectName: "Other App", action: "APPEALED", createdAt: "2026-08-30T11:00:00.000Z" }),
      action({ id: "a2", action: "APPEALED", createdAt: "2026-08-30T10:00:00.000Z" }),
      action({ id: "a1" }),
    ]);
    show();

    expect(await screen.findByText(/waiting on you/i)).toBeTruthy();
    expect(screen.getAllByText(/waiting on you/i)).toHaveLength(1);
  });
});

describe("the trail itself", () => {
  /** `projectId` is SetNull, not Cascade, so the record outlives its subject
   *  on purpose — a trail that vanished with the project could be erased by
   *  deleting the project, which is the move it exists to make visible. */
  it("still names a project that has been deleted", async () => {
    listRecent.mockResolvedValue([
      action({ projectId: null, action: "APPEALED" }),
    ]);
    show();

    expect(await screen.findByText("Leaky App")).toBeTruthy();
    expect(screen.getByText(/project deleted/i)).toBeTruthy();
    // Nothing to put back, so nothing is offered.
    expect(screen.queryByRole("button", { name: /put it back/i })).toBeNull();
  });

  it("does not render a refusal as an empty history", async () => {
    listRecent.mockRejectedValue(new Error("403"));
    show();

    expect(
      await screen.findByText(/could not load moderation history/i),
    ).toBeTruthy();
  });

  it("says so when nothing has been decided", async () => {
    show();

    expect(await screen.findByText(/nothing has been decided yet/i)).toBeTruthy();
  });
});

/** Nothing prunes this table and nothing should, so "recent" was a hundred
 *  rows and a cliff — with an appeal possibly just over it, unanswerable by
 *  the only person who could answer it, and nothing on the screen saying so. */
describe("more than one page of history", () => {
  it("offers nothing to load when the log fits", async () => {
    listRecent.mockResolvedValue([action()]);
    show();

    await screen.findByText("Leaky App");
    expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
  });

  it("loads older entries and keeps the newer ones", async () => {
    listRecent.mockResolvedValueOnce({ items: [action()], nextCursor: "a1" });
    listRecent.mockResolvedValueOnce({
      items: [action({ id: "a2", projectName: "Older Case" })],
      nextCursor: null,
    });

    show();
    fireEvent.click(await screen.findByRole("button", { name: /show more/i }));

    expect(await screen.findByText("Older Case")).toBeTruthy();
    expect(screen.getByText("Leaky App")).toBeTruthy();
    expect(listRecent).toHaveBeenLastCalledWith("a1");
  });

  /** The unanswered-appeal badge reads whatever has been loaded, so an appeal
   *  that arrives with the second page has to be marked when it arrives. */
  it("marks an unanswered appeal found on a later page", async () => {
    listRecent.mockResolvedValueOnce({ items: [action()], nextCursor: "a1" });
    listRecent.mockResolvedValueOnce({
      items: [
        action({
          id: "a2",
          action: "APPEALED",
          projectId: "p2",
          projectName: "Appealed Later",
        }),
      ],
      nextCursor: null,
    });

    show();
    fireEvent.click(await screen.findByRole("button", { name: /show more/i }));

    await screen.findByText("Appealed Later");
    expect(screen.getByRole("button", { name: /put it back/i })).toBeTruthy();
  });
});
