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
