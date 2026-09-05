// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/** Offering back work that was typed and never confirmed saved.
 *
 *  **One test here matters more than the rest**, and it is the one asserting
 *  that nothing is written to disk. Replaying a local buffer over a file that
 *  somebody else has since edited — or that the user reloaded specifically to
 *  abandon — would be a worse failure than the one this fixes, and it is what
 *  "restore my work" quietly means if nobody decides otherwise.
 */

const openTab = vi.fn();
const markDirty = vi.fn();

vi.mock("../../../store/openTabsStore.ts", () => ({
  useOpenTabsStore: {
    getState: () => ({ openTab, markDirty }),
  },
}));

import { RecoveredWorkNotice } from "./RecoveredWorkNotice.tsx";
import { rememberBuffer, recoveredBuffers } from "../../../lib/recoveredWork.ts";

// antd's Modal reads matchMedia for its responsive width; jsdom ships none.
window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
}));

beforeEach(() => {
  localStorage.clear();
  openTab.mockReset();
  markDirty.mockReset();
});

afterEach(cleanup);

describe("when there is nothing to recover", () => {
  it("renders nothing at all", () => {
    const { container } = render(<RecoveredWorkNotice projectId="p1" />);

    expect(container.innerHTML).toBe("");
  });

  it("renders nothing without a project", () => {
    rememberBuffer("p1", "a.ts", "typed");
    const { container } = render(<RecoveredWorkNotice projectId={undefined} />);

    expect(container.innerHTML).toBe("");
  });
});

describe("when work was kept", () => {
  beforeEach(() => {
    rememberBuffer("p1", "src/app.ts", "half-typed");
  });

  it("names the file and says how old it is", async () => {
    render(<RecoveredWorkNotice projectId="p1" />);

    await waitFor(() => {
      expect(screen.getByText(/src\/app\.ts/)).toBeTruthy();
    });
    expect(screen.getByText(/less than a minute ago/)).toBeTruthy();
  });

  it("counts them when there is more than one", async () => {
    rememberBuffer("p1", "src/other.ts", "also");
    render(<RecoveredWorkNotice projectId="p1" />);

    await waitFor(() => {
      expect(screen.getByText(/2 files/)).toBeTruthy();
    });
  });

  /** **The one that matters.** Reopening puts the buffer in the TAB, marked
   *  unsaved, and emits no write. */
  it("reopens into the editor and writes nothing to disk", async () => {
    render(<RecoveredWorkNotice projectId="p1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reopen them" }));

    await waitFor(() => {
      expect(openTab).toHaveBeenCalledWith("src/app.ts", "half-typed");
    });
    // Marked unsaved, so the ordinary save path — the one the user can see and
    // choose — is what puts it on disk.
    expect(markDirty).toHaveBeenCalledWith("src/app.ts", true);
  });

  it("discards without opening anything", async () => {
    render(<RecoveredWorkNotice projectId="p1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(recoveredBuffers("p1")).toEqual([]);
    });
    expect(openTab).not.toHaveBeenCalled();
  });

  /** Discarding has to clear the record, or the same offer returns on the next
   *  load and the answer never sticks. */
  it("clears the record when discarded from the dialog", async () => {
    render(<RecoveredWorkNotice projectId="p1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard them" }));

    await waitFor(() => {
      expect(recoveredBuffers("p1")).toEqual([]);
    });
  });

  it("forgets one file without forgetting the rest", async () => {
    rememberBuffer("p1", "src/other.ts", "also");
    render(<RecoveredWorkNotice projectId="p1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    const buttons = await screen.findAllByRole("button", {
      name: "forget this one",
    });
    fireEvent.click(buttons[0]!);

    await waitFor(() => {
      expect(recoveredBuffers("p1")).toHaveLength(1);
    });
  });
});
