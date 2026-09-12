// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GitStash } from "@replit-clone/shared";

const getStashes = vi.fn();
const pushStash = vi.fn();
const applyStash = vi.fn();
const dropStash = vi.fn();

vi.mock("../../../apis/projects.ts", () => ({
  getStashesApi: () => getStashes() as unknown,
  pushStashApi: (_id: string, message: string, untracked: boolean) =>
    pushStash(message, untracked) as unknown,
  applyStashApi: (_id: string, index: number, drop: boolean) =>
    applyStash(index, drop) as unknown,
  dropStashApi: (_id: string, index: number) => dropStash(index) as unknown,
}));

import { StashSection } from "./StashSection.tsx";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const STASH: GitStash = {
  ref: "stash@{0}",
  index: 0,
  message: "half a refactor",
  branch: "main",
  at: "2026-09-10T00:00:00Z",
};

/** No provider: this renders inside `SourceControlPanel`, which has none. That
 *  is the point of the component reading its own data with plain state. */
function show(canEdit = true) {
  return render(
    <StashSection projectId={PROJECT} canEdit={canEdit} onChanged={() => {}} />,
  );
}

beforeEach(() => {
  getStashes.mockReset().mockResolvedValue([STASH]);
  pushStash.mockReset().mockResolvedValue([]);
  applyStash.mockReset().mockResolvedValue({ stashes: [], status: {} });
  dropStash.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe("stashes", () => {
  it("lists what is stashed, with the branch it came from", async () => {
    show();
    expect(await screen.findByText("half a refactor")).toBeTruthy();
    // Most of how somebody tells two stashes apart.
    expect(screen.getByText(/on main/)).toBeTruthy();
  });

  it("applies without deleting", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));

    // The primary action keeps the stash: one you meant to keep and popped is
    // recoverable only through the reflog, which nobody reaches for in time.
    await waitFor(() => {
      expect(applyStash).toHaveBeenCalledWith(0, false);
    });
  });

  it("includes untracked files when stashing", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Stash changes" }));
    fireEvent.change(screen.getByLabelText("Stash message"), {
      target: { value: "wip" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Stash" }));

    // A stash that silently leaves new files behind is a stash that loses them
    // at the next checkout.
    await waitFor(() => {
      expect(pushStash).toHaveBeenCalledWith("wip", true);
    });
  });

  it("shows nothing to do when there are no stashes", async () => {
    getStashes.mockResolvedValue([]);
    show();
    expect(await screen.findByText("Nothing stashed.")).toBeTruthy();
  });

  it("offers a viewer no buttons that change the repository", async () => {
    show(false);
    await screen.findByText("half a refactor");

    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stash changes" })).toBeNull();
  });
});
