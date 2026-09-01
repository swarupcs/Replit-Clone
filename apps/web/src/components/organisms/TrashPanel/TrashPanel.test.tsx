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

/** The screen that makes delete recoverable.
 *
 *  A trash nobody can see is a delete with extra steps, which is the shape
 *  §2.21 had to pay for once already: the server grew a whole feature and no
 *  person could reach any of it.
 */

const listTrash = vi.fn();
const restore = vi.fn();
const purge = vi.fn();

vi.mock("../../../apis/projects.ts", () => ({
  listTrashApi: () => listTrash() as unknown,
  restoreProjectApi: (id: string) => restore(id) as unknown,
  purgeProjectApi: (id: string) => purge(id) as unknown,
}));

import { TrashPanel } from "./TrashPanel.tsx";

const DAY = 86_400_000;

function trashed(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    name: "Leaky App",
    template: "react-vite",
    // Deleted two days ago, so five of seven remain.
    deletedAt: new Date(Date.now() - 2 * DAY).toISOString(),
    ...over,
  };
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <TrashPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listTrash.mockReset().mockResolvedValue({ trashDays: 7, projects: [trashed()] });
  restore.mockReset().mockResolvedValue({ id: "p1" });
  purge.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("what the trash shows", () => {
  /** The number somebody needs is how long they have left, not when they
   *  pressed the button. */
  it("counts down rather than reporting a date", async () => {
    show();

    expect(await screen.findByText("Leaky App")).toBeTruthy();
    expect(screen.getByText("5 days left")).toBeTruthy();
  });

  it("says today when the week is up", async () => {
    listTrash.mockResolvedValue({
      trashDays: 7,
      projects: [trashed({ deletedAt: new Date(Date.now() - 8 * DAY).toISOString() })],
    });
    show();

    expect(await screen.findByText(/deleted for good today/i)).toBeTruthy();
  });

  it("says what the trash is for when it is empty", async () => {
    listTrash.mockResolvedValue({ trashDays: 7, projects: [] });
    show();

    expect(await screen.findByText(/nothing deleted in the last week/i)).toBeTruthy();
  });

  /** Both facts matter and neither is obvious: a project in here is not
   *  serving anything, and it is not costing the owner their quota. */
  it("says a trashed project is offline and free", async () => {
    show();

    await screen.findByText("Leaky App");
    expect(screen.getByText(/stopped and offline/i)).toBeTruthy();
    expect(screen.getByText(/do not count against your quota/i)).toBeTruthy();
  });

  it("does not render a refusal as an empty trash", async () => {
    listTrash.mockRejectedValue(new Error("403"));
    show();

    expect(await screen.findByText(/could not load the trash/i)).toBeTruthy();
  });
});

describe("putting one back", () => {
  it("restores on one press, with no confirmation", async () => {
    // Undo is the safe direction. A dialog in front of it would be friction
    // on the recovery and none on the loss.
    show();
    fireEvent.click(await screen.findByRole("button", { name: /restore/i }));

    await waitFor(() => {
      expect(restore).toHaveBeenCalledWith("p1");
    });
  });

  /** Trashing stops a project counting against the quota, so an account can
   *  be full by the time somebody changes their mind. Which limit was hit is
   *  the whole content of that failure. */
  it("passes the server's reason through when there is no room", async () => {
    restore.mockRejectedValue({
      response: { data: { message: "You have reached the limit of 3 projects." } },
    });
    show();
    fireEvent.click(await screen.findByRole("button", { name: /restore/i }));

    expect(await screen.findByText(/limit of 3 projects/i)).toBeTruthy();
  });
});

describe("emptying it by hand", () => {
  /** The one action here that cannot be undone is the one that keeps its
   *  dialog. */
  it("asks first, and says which half is permanent", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: /delete now/i }));

    expect(await screen.findByText(/cannot be undone/i)).toBeTruthy();
    expect(purge).not.toHaveBeenCalled();
  });

  it("purges once confirmed", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: /delete now/i }));
    fireEvent.click(await screen.findByRole("button", { name: /delete for good/i }));

    await waitFor(() => {
      expect(purge).toHaveBeenCalledWith("p1");
    });
  });
});
