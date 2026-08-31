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
import { MemoryRouter } from "react-router-dom";
import type { Project, TemplateSummary } from "@replit-clone/shared";
import { Dashboard } from "./Dashboard.tsx";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

const api = vi.hoisted(() => ({
  listProjectsApi: vi.fn(),
  listTemplatesApi: vi.fn(),
  createProjectApi: vi.fn(),
  deleteProjectApi: vi.fn(),
  duplicateProjectApi: vi.fn(),
  renameProjectApi: vi.fn(),
  projectExportUrl: vi.fn(() => "http://export"),
  // The Explore section reads this. Empty by default so it renders nothing at
  // all, which keeps every assertion below about the user's OWN projects --
  // otherwise a public project and a personal one would both match a query
  // like "shows the projects once they load".
  listPublicProjectsApi: vi.fn().mockResolvedValue([]),
  forkProjectApi: vi.fn(),
  setProjectVisibilityApi: vi.fn(),
  // The moderation dialog reads these. Mocked here because the module is
  // replaced wholesale, so a missing export is a crash rather than a 403.
  listProjectModerationApi: vi.fn().mockResolvedValue([]),
  appealTakedownApi: vi.fn(),
  // And the plan dialog reads this one, for the same reason.
  getAccountApi: vi.fn().mockResolvedValue({
    email: "someone@example.com",
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
    projects: 0,
    diskBytes: 0,
    breakdown: [],
    plans: [],
  }),
}));
vi.mock("../apis/projects.ts", () => api);

vi.mock("../hooks/useAuth.ts", () => ({
  useAuth: () => ({
    user: { id: "u1", email: "someone@example.com" },
    logout: vi.fn(),
  }),
}));

// The share dialog fetches collaborators of its own; the dashboard's job is
// only to open it for the right project.
vi.mock("../components/organisms/ShareDialog/ShareDialog.tsx", () => ({
  ShareDialog: ({ projectName }: { projectName: string }) => (
    <div data-testid="share-dialog">{projectName}</div>
  ),
}));

function project(over: Partial<Project> & { id: string; name: string }): Project {
  return {
    // Owned by the signed-in user: the menu omits share/rename/delete on a
    // project shared with you, by design.
    ownerId: "u1",
    template: "react-vite",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: null,
    ...over,
  } as Project;
}

const PROJECTS: Project[] = [
  project({
    id: "a",
    name: "Zebra",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-08-01T00:00:00.000Z",
  }),
  project({
    id: "b",
    name: "Apple",
    template: "python-flask",
    createdAt: "2026-06-01T00:00:00.000Z",
    lastActiveAt: "2026-02-01T00:00:00.000Z",
  }),
];

const TEMPLATES: TemplateSummary[] = [
  {
    id: "react-vite",
    label: "React",
    devPort: 5173,
    previewPorts: [5173],
    startCommand: "npm run dev",
  },
  {
    id: "python-flask",
    label: "Flask",
    devPort: 5000,
    previewPorts: [5000],
    startCommand: "python app.py",
  },
];

function renderDashboard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The rendered project names, in card order. Taken from the card's action
 *  button, which is the one element naming its project. */
function cardNames() {
  return [...document.querySelectorAll(".rc-card")].map((card) =>
    card
      .querySelector("[aria-label^='Actions for ']")
      ?.getAttribute("aria-label")
      ?.replace("Actions for ", ""),
  );
}

beforeEach(() => {
  api.listProjectsApi.mockResolvedValue(PROJECTS);
  api.listTemplatesApi.mockResolvedValue(TEMPLATES);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Dashboard listing", () => {
  it("shows the projects once they load", async () => {
    renderDashboard();
    expect(await screen.findByText("Zebra")).toBeDefined();
    expect(screen.getByText("Apple")).toBeDefined();
  });

  /** The grid used to show a centred spinner and then swap in cards, so the
   *  whole page jumped the moment the projects landed. */
  it("holds the grid's shape while the projects load", () => {
    // A promise that never settles: the loading state is the subject, and a
    // resolved mock is already past it by the first assertion.
    api.listProjectsApi.mockReturnValue(new Promise(() => undefined));
    renderDashboard();

    expect(document.querySelectorAll(".rc-skeleton-card").length).toBeGreaterThan(
      0,
    );
    expect(document.querySelector(".ant-spin")).toBeNull();
  });

  it("puts the skeletons away once the projects arrive", async () => {
    renderDashboard();
    await screen.findByText("Zebra");

    expect(document.querySelectorAll(".rc-skeleton-card")).toHaveLength(0);
  });

  it("opens a project when its card is clicked", async () => {
    renderDashboard();
    fireEvent.click(await screen.findByText("Zebra"));

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith("/project/a");
    });
  });

  it("says so when there are no projects at all", async () => {
    api.listProjectsApi.mockResolvedValue([]);
    renderDashboard();

    await waitFor(() => {
      expect(document.querySelectorAll(".rc-card")).toHaveLength(0);
    });
  });
});

describe("Dashboard filtering and sorting", () => {
  it("filters by name", async () => {
    renderDashboard();
    await screen.findByText("Zebra");

    fireEvent.change(screen.getByPlaceholderText("Search projects"), {
      target: { value: "app" },
    });

    expect(screen.getByText("Apple")).toBeDefined();
    expect(screen.queryByText("Zebra")).toBeNull();
  });

  it("filters by template, not just name", async () => {
    renderDashboard();
    await screen.findByText("Zebra");

    fireEvent.change(screen.getByPlaceholderText("Search projects"), {
      target: { value: "flask" },
    });

    expect(screen.getByText("Apple")).toBeDefined();
    expect(screen.queryByText("Zebra")).toBeNull();
  });

  it("ignores case and surrounding space in the query", async () => {
    renderDashboard();
    await screen.findByText("Zebra");

    fireEvent.change(screen.getByPlaceholderText("Search projects"), {
      target: { value: "  ZEB  " },
    });

    expect(screen.getByText("Zebra")).toBeDefined();
  });

  it("orders by last activity by default, not by creation", async () => {
    renderDashboard();
    await screen.findByText("Zebra");

    // Apple was created later, but Zebra was opened more recently.
    expect(cardNames()[0]).toBe("Zebra");
  });
});

describe("Dashboard project actions", () => {
  /** Opens the overflow menu on the named project's card. */
  async function openMenu(name: string) {
    fireEvent.click(await screen.findByLabelText(`Actions for ${name}`));
  }

  it("deletes a project after confirming", async () => {
    api.deleteProjectApi.mockResolvedValue(undefined);
    renderDashboard();
    await openMenu("Zebra");

    // The menu item, which opens the confirmation.
    fireEvent.click(await screen.findByText("Delete"));

    // The confirmation names the project, so a mis-click cannot delete the
    // wrong card.
    expect(await screen.findByText("Delete this project?")).toBeDefined();
    const confirm = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Delete",
    );
    fireEvent.click(confirm as HTMLElement);

    await waitFor(() => {
      expect(api.deleteProjectApi).toHaveBeenCalled();
    });
    // react-query hands the mutation function a context object alongside the
    // variable, so only the first argument is ours to assert on.
    expect(api.deleteProjectApi.mock.calls[0]?.[0]).toBe("a");
  });

  it("duplicates a project", async () => {
    api.duplicateProjectApi.mockResolvedValue({ ...PROJECTS[0]!, id: "c" });
    renderDashboard();
    await openMenu("Zebra");

    fireEvent.click(await screen.findByText("Duplicate"));

    await waitFor(() => {
      expect(api.duplicateProjectApi).toHaveBeenCalledWith("a");
    });
  });

  it("opens the share dialog for the right project", async () => {
    renderDashboard();
    await openMenu("Apple");

    fireEvent.click(await screen.findByText("Share"));

    expect((await screen.findByTestId("share-dialog")).textContent).toBe("Apple");
  });
});

describe("Dashboard creating", () => {
  it("creates a project and navigates into it", async () => {
    api.createProjectApi.mockResolvedValue({ ...PROJECTS[0]!, id: "new" });
    renderDashboard();

    fireEvent.click(await screen.findByText("New playground"));
    fireEvent.click(await screen.findByText("Create"));

    await waitFor(() => {
      expect(api.createProjectApi).toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith("/project/new");
    });
  });

  it("stays put when creating fails", async () => {
    api.createProjectApi.mockRejectedValue(new Error("nope"));
    renderDashboard();

    fireEvent.click(await screen.findByText("New playground"));
    fireEvent.click(await screen.findByText("Create"));

    await waitFor(() => {
      expect(api.createProjectApi).toHaveBeenCalled();
    });
    expect(navigate).not.toHaveBeenCalled();
  });
});

/** Cards or a list.
 *
 *  The point of the list is scanning: past roughly thirty projects a card is
 *  mostly whitespace and the name is three lines down in each of them. These
 *  pin down that both layouts show the same projects and offer the same
 *  actions, which is the pair most likely to drift once there are two of them.
 */
describe("choosing a layout", () => {
  beforeEach(() => {
    // The choice is remembered in localStorage, which does not reset between
    // tests -- found by two of these failing because the one before them had
    // switched to list and left it there. Proof the persistence works, and a
    // reason each test has to start from a known layout.
    localStorage.clear();
  });

  function rowNames() {
    return [...document.querySelectorAll(".rc-project-row")].map((row) =>
      row
        .querySelector("[aria-label^='Actions for ']")
        ?.getAttribute("aria-label")
        ?.replace("Actions for ", ""),
    );
  }

  it("shows cards to begin with", async () => {
    api.listProjectsApi.mockResolvedValue(PROJECTS);
    renderDashboard();

    await screen.findByText("Zebra");
    expect(document.querySelectorAll(".rc-card").length).toBe(2);
    expect(document.querySelectorAll(".rc-project-row").length).toBe(0);
  });

  it("switches to one row per project", async () => {
    api.listProjectsApi.mockResolvedValue(PROJECTS);
    renderDashboard();

    await screen.findByText("Zebra");
    fireEvent.click(screen.getByLabelText("List view"));

    expect(rowNames()).toEqual(["Zebra", "Apple"]);
    expect(document.querySelectorAll(".rc-card").length).toBe(0);
  });

  it("puts the rows in a container the list styles apply to", async () => {
    // The rows carry their own class, so they render either way -- which
    // means every other test here passes with the container left as a grid,
    // and the list arrives with no border, no separators and card spacing.
    // Found by mutation: this is the assertion that was missing.
    api.listProjectsApi.mockResolvedValue(PROJECTS);
    renderDashboard();

    await screen.findByText("Zebra");
    expect(document.querySelector(".rc-project-list")).toBeNull();

    fireEvent.click(screen.getByLabelText("List view"));

    expect(document.querySelector(".rc-project-list")).not.toBeNull();
    expect(document.querySelector(".rc-project-grid")).toBeNull();
  });

  it("holds the shape it is about to have while loading", async () => {
    // The skeletons exist so the page does not jump when the projects land.
    // Card-shaped placeholders inside a list would jump twice: once for the
    // data, once for the layout correcting itself.
    localStorage.setItem("rc.dashboard.view", "list");
    let resolve: (value: Project[]) => void = () => undefined;
    api.listProjectsApi.mockReturnValue(
      new Promise<Project[]>((done) => {
        resolve = done;
      }),
    );

    renderDashboard();

    const loading = await screen.findByLabelText("Loading projects");
    expect(loading.className).toBe("rc-project-list");
    // Scoped to this container: the Explore section below renders skeleton
    // cards of its own, and they are not what this is about.
    expect(loading.querySelectorAll(".rc-skeleton-row").length).toBeGreaterThan(0);
    expect(loading.querySelectorAll(".rc-skeleton-card").length).toBe(0);

    resolve(PROJECTS);
    await screen.findByText("Zebra");
  });

  it("shows the same projects in the same order in both", async () => {
    // The sort is the user's, and the layout is a display choice. A list that
    // reordered would look like a bug in the sort.
    api.listProjectsApi.mockResolvedValue(PROJECTS);
    renderDashboard();

    await screen.findByText("Zebra");
    const cards = cardNames();

    fireEvent.click(screen.getByLabelText("List view"));

    expect(rowNames()).toEqual(cards);
  });

  it("keeps the search filter across a layout change", async () => {
    api.listProjectsApi.mockResolvedValue(PROJECTS);
    renderDashboard();

    await screen.findByText("Zebra");
    fireEvent.change(screen.getByPlaceholderText("Search projects"), {
      target: { value: "app" },
    });
    await waitFor(() => {
      expect(cardNames()).toEqual(["Apple"]);
    });

    fireEvent.click(screen.getByLabelText("List view"));

    expect(rowNames()).toEqual(["Apple"]);
  });

  it("opens a project from a row", async () => {
    api.listProjectsApi.mockResolvedValue(PROJECTS);
    renderDashboard();

    await screen.findByText("Zebra");
    fireEvent.click(screen.getByLabelText("List view"));

    const row = document.querySelectorAll(".rc-project-row")[0];
    fireEvent.click(row!);

    expect(navigate).toHaveBeenCalledWith("/project/a");
  });

  it("offers the same actions from a row as from a card", async () => {
    // One menu, rendered by both. The version of this that goes wrong is two
    // copies where the list quietly loses Delete for owners.
    api.listProjectsApi.mockResolvedValue(PROJECTS);
    renderDashboard();

    await screen.findByText("Zebra");
    fireEvent.click(screen.getByLabelText("List view"));

    fireEvent.click(screen.getAllByLabelText("Actions for Zebra")[0]!);

    for (const label of ["Share", "Rename", "Duplicate", "Delete"]) {
      expect(await screen.findByText(label)).toBeTruthy();
    }
  });

  it("does not open the project when the row's menu is clicked", async () => {
    // The menu sits inside the row's click target, so without the stopped
    // propagation every menu click also navigates away from the page holding
    // the menu.
    api.listProjectsApi.mockResolvedValue(PROJECTS);
    renderDashboard();

    await screen.findByText("Zebra");
    fireEvent.click(screen.getByLabelText("List view"));
    fireEvent.click(screen.getAllByLabelText("Actions for Zebra")[0]!);

    expect(navigate).not.toHaveBeenCalled();
  });

  it("remembers the layout for next time", async () => {
    api.listProjectsApi.mockResolvedValue(PROJECTS);
    const first = renderDashboard();

    await screen.findByText("Zebra");
    fireEvent.click(screen.getByLabelText("List view"));
    first.unmount();

    renderDashboard();
    await screen.findByText("Zebra");

    expect(document.querySelectorAll(".rc-project-row").length).toBe(2);
  });

  it("renders as cards when the stored preference cannot be read", async () => {
    // A private window, or a browser blocking site data, makes the accessor
    // itself throw rather than return null. A dashboard that fails to render
    // over a display preference would be the worst possible trade.
    //
    // Spied on the INSTANCE, not on `Storage.prototype`: the test setup
    // installs its own MemoryStorage, so a prototype spy applies to nothing
    // and this test passed against code with no try/catch at all. Caught by
    // reverting the guard and finding the test still green.
    const getItem = vi
      .spyOn(globalThis.localStorage, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });

    api.listProjectsApi.mockResolvedValue(PROJECTS);
    expect(() => renderDashboard()).not.toThrow();
    await screen.findByText("Zebra");
    expect(document.querySelectorAll(".rc-card").length).toBe(2);

    getItem.mockRestore();
  });

  it("keeps working when the preference cannot be written", async () => {
    // The other half. Losing the preference is acceptable; losing the click
    // that set it is not.
    const setItem = vi
      .spyOn(globalThis.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });

    api.listProjectsApi.mockResolvedValue(PROJECTS);
    renderDashboard();
    await screen.findByText("Zebra");

    expect(() => {
      fireEvent.click(screen.getByLabelText("List view"));
    }).not.toThrow();
    expect(document.querySelectorAll(".rc-project-row").length).toBe(2);

    setItem.mockRestore();
  });
});

/** A takedown was a notification and then a dead end: nothing in `apps/web`
 *  mentioned it, so the owner could not read the decision or answer it.
 *  §2.17 shipped all three endpoints and no caller. */
describe("Dashboard, a project taken down", () => {
  const TAKEN_DOWN = "2026-08-30T09:00:00.000Z";

  beforeEach(() => {
    api.listProjectsApi.mockResolvedValue([
      project({ id: "p9", name: "Leaky", takenDownAt: TAKEN_DOWN }),
      project({ id: "p8", name: "Fine" }),
    ]);
  });

  it("says so on the card, without the owner having to open anything", async () => {
    renderDashboard();

    expect(await screen.findByText("Taken down")).toBeDefined();
  });

  /** The server refuses this, because a copy would hold the same files with
   *  none of the takedown. The menu says so by omission rather than offering
   *  something that fails. */
  it("does not offer to duplicate it", async () => {
    renderDashboard();
    fireEvent.click(await screen.findByLabelText("Actions for Leaky"));

    // The menu opened -- the entry reads "Taken down" too, so wait on the
    // menuitem rather than the card badge behind it.
    expect(
      await screen.findByRole("menuitem", { name: /taken down/i }),
    ).toBeDefined();
    expect(screen.queryByText("Duplicate")).toBeNull();
  });

  it("still offers to duplicate one nobody took down", async () => {
    renderDashboard();
    fireEvent.click(await screen.findByLabelText("Actions for Fine"));

    expect(await screen.findByText("Duplicate")).toBeDefined();
  });

  it("opens the trail and the appeal", async () => {
    renderDashboard();
    fireEvent.click(await screen.findByLabelText("Actions for Leaky"));
    // The menu entry, not the card badge: both read "Taken down", and the
    // menu item is the one that is a button.
    fireEvent.click(await screen.findByRole("menuitem", { name: /taken down/i }));

    expect(await screen.findByLabelText("Your appeal")).toBeDefined();
  });
});
