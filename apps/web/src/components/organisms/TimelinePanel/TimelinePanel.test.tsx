// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const getTimeline = vi.fn();
const getVersion = vi.fn();
vi.mock("../../../apis/projects.ts", () => ({
  getTimelineApi: (_id: string, path: string) => getTimeline(path) as unknown,
  getTimelineVersionApi: (_id: string, path: string, at: number) =>
    getVersion(path, at) as unknown,
}));

import { TimelinePanel } from "./TimelinePanel.tsx";
import { useCompareStore } from "../../../store/compareStore.ts";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
/** Real timers, offsets from now. Fake timers stop `findBy` polling, which is
 *  a testing-library detail rather than anything about this component. */
beforeEach(() => {
  const now = Date.now();
  getTimeline.mockReset().mockResolvedValue([
    { at: now - 12 * 60 * 1000, bytes: 2048 },
    { at: now - 3 * 60 * 60 * 1000, bytes: 1024 },
  ]);
  getVersion.mockReset().mockResolvedValue("the old contents");
  useCompareStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

describe("a file's own history", () => {
  it("lists saved versions, newest first", async () => {
    render(<TimelinePanel projectId={PROJECT} relPath="src/a.ts" />);
    // Relative while that is the useful answer -- "12 min ago" is what somebody
    // is asking when they open this.
    expect(await screen.findByText("12 min ago")).toBeTruthy();
    expect(screen.getByText("3 h ago")).toBeTruthy();
  });

  it("puts a chosen version in the diff pane rather than over the file", async () => {
    render(<TimelinePanel projectId={PROJECT} relPath="src/a.ts" />);
    fireEvent.click(await screen.findByLabelText("Compare with 12 min ago"));

    // What somebody wants is usually three lines out of it, not the whole file
    // back -- so it opens as a comparison, which §10.11 made possible.
    await waitFor(() => {
      expect(useCompareStore.getState().left).toBe("the old contents");
    });
  });

  it("says what to do when the file has never been saved", async () => {
    getTimeline.mockResolvedValue([]);
    render(<TimelinePanel projectId={PROJECT} relPath="src/new.ts" />);

    expect(await screen.findByText(/One is kept each time you save/)).toBeTruthy();
  });

  it("asks for nothing until a file is open", () => {
    render(<TimelinePanel projectId={PROJECT} relPath={null} />);
    expect(screen.getByText("Open a file to see its history.")).toBeTruthy();
    expect(getTimeline).not.toHaveBeenCalled();
  });

  it("says these are not a backup, because they are on the same disk", async () => {
    render(<TimelinePanel projectId={PROJECT} relPath="src/a.ts" />);
    expect(await screen.findByText(/not a backup/)).toBeTruthy();
  });

  it("re-reads the list when a version has been pruned away", async () => {
    render(<TimelinePanel projectId={PROJECT} relPath="src/a.ts" />);
    await screen.findByText("12 min ago");
    getTimeline.mockClear();
    getVersion.mockRejectedValue(new Error("gone"));

    fireEvent.click(screen.getByLabelText("Compare with 12 min ago"));

    // The service keeps a bounded number, so a version vanishing between
    // listing and opening is a thing that legitimately happens.
    await waitFor(() => {
      expect(getTimeline).toHaveBeenCalled();
    });
  });

  it("follows the file that is open", async () => {
    const { rerender } = render(<TimelinePanel projectId={PROJECT} relPath="a.ts" />);
    await waitFor(() => {
      expect(getTimeline).toHaveBeenCalledWith("a.ts");
    });

    rerender(<TimelinePanel projectId={PROJECT} relPath="b.ts" />);
    await waitFor(() => {
      expect(getTimeline).toHaveBeenCalledWith("b.ts");
    });
  });
});
