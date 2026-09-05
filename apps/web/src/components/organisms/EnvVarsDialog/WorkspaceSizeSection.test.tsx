// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkspaceSize } from "../../../apis/projects.ts";

/** plan.md §12.1 on a screen.
 *
 *  The control itself is two number boxes and is not what these tests are
 *  about. What they are about is the sentence underneath them: a field
 *  containing "2048" is not something anybody can act on, and the question
 *  this panel is opened to answer is "can I give it more". A panel that showed
 *  only the current size would answer that by refusing after the fact, which
 *  is exactly the mistake §2.22 exists to correct.
 */

const getSize = vi.fn();
const setSize = vi.fn();

vi.mock("../../../apis/projects.ts", () => ({
  getWorkspaceSizeApi: (id: string) => getSize(id) as unknown,
  setWorkspaceSizeApi: (id: string, size: unknown) => setSize(id, size) as unknown,
}));

import { WorkspaceSizeSection } from "./WorkspaceSizeSection.tsx";

const PROJECT = "11111111-1111-4111-8111-111111111111";

function size(over: Partial<WorkspaceSize> = {}): WorkspaceSize {
  return {
    memoryMb: 512,
    cpus: 0.5,
    custom: false,
    defaultMemoryMb: 512,
    defaultCpus: 0.5,
    budgetMb: 15360,
    committedMb: 1024,
    minMemoryMb: 256,
    ...over,
  };
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <WorkspaceSizeSection projectId={PROJECT} enabled />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getSize.mockReset().mockResolvedValue(size());
  setSize.mockReset().mockResolvedValue({ memoryMb: 8192, cpus: 4, custom: true });
});

afterEach(cleanup);

describe("what it says before anybody types", () => {
  it("says the size is the deployment's, not this workspace's", async () => {
    show();

    expect(await screen.findByText(/using the deployment's default/i)).toBeTruthy();
  });

  it("says this workspace's own size once it has one", async () => {
    getSize.mockResolvedValue(size({ custom: true, memoryMb: 8192, cpus: 4 }));
    show();

    expect(await screen.findByText(/this workspace: 8192 MB, 4 CPUs/i)).toBeTruthy();
  });

  /** The half that makes a number choosable rather than guessable. */
  it("says what the host has and how much of it is free", async () => {
    show();

    const line = await screen.findByText(/this host has/i);
    expect(line.textContent).toContain("15360 MB");
    // 15360 budget less 1024 already committed to other running workspaces.
    expect(line.textContent).toContain("14336 MB");
  });

  /** Docker will move a running container's cgroup, but the process inside it
   *  has already read /proc/meminfo and sized its heap. Saying so here is
   *  cheaper than somebody discovering the numbers did not change. */
  it("says a new size is not applied to what is already running", async () => {
    show();

    expect(await screen.findByText(/next time this workspace starts/i)).toBeTruthy();
  });
});

describe("the boxes", () => {
  /** Empty means "the default". Pre-filling them with the default would make
   *  clearing one impossible to distinguish from choosing it. */
  it("start empty for a workspace nobody has sized", async () => {
    show();

    await screen.findByText(/using the deployment's default/i);
    expect(screen.getByLabelText("Memory in MB").getAttribute("value")).toBe("");
    expect(screen.getByLabelText("CPUs").getAttribute("value")).toBe("");
  });

  it("carry this workspace's numbers when it has them", async () => {
    getSize.mockResolvedValue(size({ custom: true, memoryMb: 8192, cpus: 4 }));
    show();

    await screen.findByText(/this workspace: 8192 MB/i);
    expect(screen.getByLabelText("Memory in MB").getAttribute("value")).toBe("8192");
  });

  it("sends both halves, so clearing one goes back to the default", async () => {
    show();
    await screen.findByText(/using the deployment's default/i);

    fireEvent.click(screen.getByRole("button", { name: /save size/i }));

    await waitFor(() => {
      expect(setSize).toHaveBeenCalledWith(PROJECT, { memoryMb: null, cpus: null });
    });
  });
});

describe("a refusal", () => {
  /** The server's message names what the host has and what is already
   *  committed, and that is the entire value of it — replacing it with
   *  something generic would throw away the only actionable part. */
  it("is shown in the server's own words", async () => {
    setSize.mockRejectedValue({
      response: {
        data: { message: "12288 MB of 15360 MB is already committed to running workspaces." },
      },
    });
    show();
    await screen.findByText(/using the deployment's default/i);

    fireEvent.click(screen.getByRole("button", { name: /save size/i }));

    expect(await screen.findByText(/12288 MB of 15360 MB/)).toBeTruthy();
  });

  it("still says something when the server said nothing useful", async () => {
    setSize.mockRejectedValue(new Error("network"));
    show();
    await screen.findByText(/using the deployment's default/i);

    fireEvent.click(screen.getByRole("button", { name: /save size/i }));

    expect(await screen.findByText(/could not save that size/i)).toBeTruthy();
  });
});

/** A deployment that cannot answer must not render a control that looks like
 *  it works. */
it("renders nothing at all while it does not know the size", () => {
  getSize.mockReturnValue(new Promise(() => undefined));
  const { container } = show();

  expect(container.textContent).toBe("");
});
