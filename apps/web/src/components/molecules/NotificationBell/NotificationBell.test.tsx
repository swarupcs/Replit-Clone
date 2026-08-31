// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/** The bell.
 *
 *  This is the channel that always works — no SMTP, no verified address —
 *  which is why the tests here are mostly about it staying usable when things
 *  go wrong. A bell that throws on a flaky connection, or clears a badge it
 *  did not manage to clear, is worse than the silence it replaced.
 */
const listNotifications = vi.fn();
const markRead = vi.fn();
const navigate = vi.fn();

vi.mock("../../../apis/notifications.ts", () => ({
  listNotificationsApi: () => listNotifications() as unknown,
  markNotificationsReadApi: (ids?: string[]) => markRead(ids) as unknown,
}));

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

import { NotificationBell } from "./NotificationBell.tsx";

const FAILING = {
  id: "n1",
  kind: "JOB_FAILING" as const,
  title: '"Nightly backup" is failing',
  body: "It exited non-zero.",
  link: "/project/p1?view=jobs",
  readAt: null,
  createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
};

const show = () =>
  render(
    <MemoryRouter>
      <NotificationBell />
    </MemoryRouter>,
  );

beforeEach(() => {
  listNotifications.mockReset().mockResolvedValue({ items: [], unread: 0 });
  markRead.mockReset().mockResolvedValue({ items: [], unread: 0 });
  navigate.mockReset();
});

afterEach(cleanup);

describe("the badge", () => {
  it("counts what is unread", async () => {
    listNotifications.mockResolvedValue({ items: [FAILING], unread: 1 });
    show();

    expect(
      await screen.findByLabelText("Notifications, 1 unread"),
    ).toBeTruthy();
  });

  it("says nothing when there is nothing", async () => {
    show();
    expect(await screen.findByLabelText("Notifications")).toBeTruthy();
  });

  it("stays usable when the server cannot be reached", async () => {
    // A bell with nothing to show, not a crash and not a toast every minute.
    listNotifications.mockRejectedValue(new Error("offline"));
    show();

    expect(await screen.findByLabelText("Notifications")).toBeTruthy();
  });
});

describe("the list", () => {
  it("shows what happened and when", async () => {
    listNotifications.mockResolvedValue({ items: [FAILING], unread: 1 });
    show();

    fireEvent.click(await screen.findByLabelText("Notifications, 1 unread"));

    expect(await screen.findByText('"Nightly backup" is failing')).toBeTruthy();
    expect(screen.getByText("It exited non-zero.")).toBeTruthy();
    expect(screen.getByText("5m ago")).toBeTruthy();
  });

  it("explains itself when empty rather than showing a blank box", async () => {
    show();

    fireEvent.click(await screen.findByLabelText("Notifications"));

    expect(await screen.findByText(/scheduled job that starts failing/i)).toBeTruthy();
  });
});

describe("acting on one", () => {
  it("marks it read and goes where it points", async () => {
    listNotifications.mockResolvedValue({ items: [FAILING], unread: 1 });
    show();

    fireEvent.click(await screen.findByLabelText("Notifications, 1 unread"));
    fireEvent.click(await screen.findByText('"Nightly backup" is failing'));

    await waitFor(() => {
      expect(markRead).toHaveBeenCalledWith(["n1"]);
    });
    expect(navigate).toHaveBeenCalledWith("/project/p1?view=jobs");
  });

  it("still navigates when marking it read fails", async () => {
    // Going where they asked matters more than the badge.
    listNotifications.mockResolvedValue({ items: [FAILING], unread: 1 });
    markRead.mockRejectedValue(new Error("offline"));
    show();

    fireEvent.click(await screen.findByLabelText("Notifications, 1 unread"));
    fireEvent.click(await screen.findByText('"Nightly backup" is failing'));

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith("/project/p1?view=jobs");
    });
  });

  it("does not re-mark one that is already read", async () => {
    listNotifications.mockResolvedValue({
      items: [{ ...FAILING, readAt: new Date().toISOString() }],
      unread: 0,
    });
    show();

    fireEvent.click(await screen.findByLabelText("Notifications"));
    fireEvent.click(await screen.findByText('"Nightly backup" is failing'));

    await waitFor(() => {
      expect(navigate).toHaveBeenCalled();
    });
    expect(markRead).not.toHaveBeenCalled();
  });

  it("marks everything read from the header", async () => {
    listNotifications.mockResolvedValue({ items: [FAILING], unread: 1 });
    show();

    fireEvent.click(await screen.findByLabelText("Notifications, 1 unread"));
    fireEvent.click(await screen.findByText("Mark all read"));

    await waitFor(() => {
      expect(markRead).toHaveBeenCalledWith(undefined);
    });
  });

  it("leaves the badge alone when marking all read fails", async () => {
    // A badge that clears and comes back is worse than one that never cleared.
    listNotifications.mockResolvedValue({ items: [FAILING], unread: 1 });
    markRead.mockRejectedValue(new Error("offline"));
    show();

    fireEvent.click(await screen.findByLabelText("Notifications, 1 unread"));
    fireEvent.click(await screen.findByText("Mark all read"));

    await waitFor(() => {
      expect(markRead).toHaveBeenCalled();
    });
    expect(screen.getByLabelText("Notifications, 1 unread")).toBeTruthy();
  });
});
