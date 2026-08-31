// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The discovery half of forking: a list of other people's work, and a button
 *  that makes a copy yours.
 *
 *  What is worth holding here is the shape of the loop rather than the markup:
 *  a fork lands you IN the copy (not back on a list hunting for it), and the
 *  section disappears entirely when nobody has published anything, because an
 *  empty "Explore" panel on a fresh install is worse than no panel.
 */

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

const api = vi.hoisted(() => ({
  listPublicProjectsApi: vi.fn(),
  forkProjectApi: vi.fn(),
}));
vi.mock("../../../apis/projects.ts", () => api);

import { ExploreSection } from "./ExploreSection.tsx";

/** One page of the gallery. The endpoint is paged, so a bare array is a shape
 *  the component no longer speaks. */
function page(items: unknown[], nextCursor: string | null = null) {
  return { items, nextCursor };
}

const PUBLIC = [
  {
    id: "p1",
    name: "Tetris in 200 lines",
    template: "react-vite",
    createdAt: new Date().toISOString(),
    ownerName: "ada",
    forks: 3,
  },
];

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ExploreSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listPublicProjectsApi.mockResolvedValue(page(PUBLIC));
});

// This suite renders the same component repeatedly; without this the previous
// test's DOM is still mounted and every query finds two of everything.
afterEach(() => {
  cleanup();
});

describe("the explore section", () => {
  it("lists what other people have published", async () => {
    renderSection();

    expect(await screen.findByText("Tetris in 200 lines")).toBeTruthy();
  });

  it("says who made it, and how many copies exist", async () => {
    renderSection();

    expect(await screen.findByText(/by ada/)).toBeTruthy();
    expect(screen.getByText(/3 forks/)).toBeTruthy();
  });

  it("counts one fork in the singular", async () => {
    api.listPublicProjectsApi.mockResolvedValue(page([{ ...PUBLIC[0], forks: 1 }]));
    renderSection();

    expect(await screen.findByText(/1 fork(?!s)/)).toBeTruthy();
  });

  it("says nothing about forks when there are none", async () => {
    api.listPublicProjectsApi.mockResolvedValue(page([{ ...PUBLIC[0], forks: 0 }]));
    renderSection();

    await screen.findByText("Tetris in 200 lines");
    expect(screen.queryByText(/fork(s)?$/)).toBeNull();
  });

  it("opens the copy, not the original, after forking", async () => {
    // The whole point of the button. Landing back on the list, or worse in the
    // original where every keystroke is refused, is the failure this asserts
    // against.
    api.forkProjectApi.mockResolvedValue({ id: "mine-1" });
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Fork" }));

    await waitFor(() => {
      expect(api.forkProjectApi).toHaveBeenCalledWith("p1");
    });
    expect(navigate).toHaveBeenCalledWith("/project/mine-1");
  });

  it("lets you look before you fork", async () => {
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Look inside" }));

    expect(navigate).toHaveBeenCalledWith("/project/p1");
    expect(api.forkProjectApi).not.toHaveBeenCalled();
  });

  it("renders nothing at all when nobody has published anything", async () => {
    // The ordinary state of a fresh install. An empty section headed
    // "Explore" is a worse answer than no section.
    api.listPublicProjectsApi.mockResolvedValue(page([]));
    const { container } = renderSection();

    await waitFor(() => {
      expect(container.querySelector("section")).toBeNull();
    });
  });

  it("keeps the failure to itself rather than taking the page down", () => {
    // The dashboard's own projects are the reason someone is on this page;
    // a gallery that cannot load must not cost them that.
    api.listPublicProjectsApi.mockRejectedValue(new Error("nope"));

    expect(() => renderSection()).not.toThrow();
  });
});

/** The gallery grows with every public project on the machine, so it is the
 *  one list here that hands the cursor to the person rather than following it
 *  silently: a screen that quietly loads all of it is the unbounded request
 *  the page size exists to stop. */
describe("more than one page", () => {
  it("offers to show more only when there is more", async () => {
    renderSection();
    await screen.findByText("Tetris in 200 lines");

    expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
  });

  it("asks for the next page with the cursor it was given", async () => {
    api.listPublicProjectsApi.mockResolvedValueOnce(page(PUBLIC, "p1"));
    api.listPublicProjectsApi.mockResolvedValueOnce(
      page([{ ...PUBLIC[0], id: "p2", name: "Second page project" }]),
    );

    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /show more/i }));

    expect(await screen.findByText("Second page project")).toBeTruthy();
    expect(api.listPublicProjectsApi).toHaveBeenLastCalledWith("p1");
    // Both pages, not the second one replacing the first.
    expect(screen.getByText("Tetris in 200 lines")).toBeTruthy();
    // And the offer is gone, because that page said there was no more.
    expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
  });
});
