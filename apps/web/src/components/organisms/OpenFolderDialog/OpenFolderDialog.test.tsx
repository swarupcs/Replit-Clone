// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  labelFor,
  OpenFolderDialog,
  trailFor,
} from "./OpenFolderDialog.tsx";

const api = vi.hoisted(() => ({
  getLocalFolderSettingsApi: vi.fn(),
  browseLocalFoldersApi: vi.fn(),
  openLocalFolderApi: vi.fn(),
}));
vi.mock("../../../apis/projects.ts", () => api);

const onOpened = vi.fn();

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <OpenFolderDialog open onClose={() => undefined} onOpened={onOpened} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getLocalFolderSettingsApi.mockResolvedValue({
    enabled: true,
    roots: ["/home/dev/code"],
  });
  api.browseLocalFoldersApi.mockResolvedValue([
    { path: "/home/dev/code/thing", name: "thing" },
    { path: "/home/dev/code/other", name: "other" },
  ]);
  api.openLocalFolderApi.mockResolvedValue({ id: "p1", name: "thing" });
});

afterEach(() => {
  cleanup();
});

describe("when the deployment has not configured it", () => {
  it("says so rather than offering a picker that refuses everything", async () => {
    api.getLocalFolderSettingsApi.mockResolvedValue({
      enabled: false,
      roots: [],
    });

    renderDialog();

    // The first render in this file pays antd's and react-query's cold start.
    await waitFor(
      () => {
        expect(
          screen.getByText(/Opening folders is not configured/i),
        ).toBeTruthy();
      },
      { timeout: 20000 },
    );

    // And it names the setting, because "not configured" with no next step is
    // a dead end for the one person who can fix it -- who, in the single-seat
    // case this exists for, is the person reading it.
    expect(screen.getByText(/LOCAL_FOLDER_ROOTS/)).toBeTruthy();
    expect(api.browseLocalFoldersApi).not.toHaveBeenCalled();
  });
});

describe("choosing a folder", () => {
  it("starts in the only root without making anybody pick it", async () => {
    renderDialog();

    await waitFor(() => {
      expect(api.browseLocalFoldersApi).toHaveBeenCalledWith("/home/dev/code");
    });
  });

  it("offers the roots when there is more than one", async () => {
    api.getLocalFolderSettingsApi.mockResolvedValue({
      enabled: true,
      roots: ["/home/dev/code", "/srv/work"],
    });

    renderDialog();

    await waitFor(() => {
      expect(screen.getByText("/srv/work")).toBeTruthy();
    });

    // Nothing is browsed until one is chosen: there is no sensible default
    // between two roots, and guessing would put somebody in the wrong tree.
    expect(api.browseLocalFoldersApi).not.toHaveBeenCalled();
  });

  it("walks into a subfolder", async () => {
    renderDialog();

    await waitFor(() => {
      expect(screen.getByText("thing")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("thing"));

    await waitFor(() => {
      expect(api.browseLocalFoldersApi).toHaveBeenCalledWith(
        "/home/dev/code/thing",
      );
    });
  });

  it("opens the folder it is currently showing", async () => {
    renderDialog();

    await waitFor(() => {
      expect(screen.getByText("thing")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("thing"));
    await waitFor(() => {
      expect(api.browseLocalFoldersApi).toHaveBeenCalledWith(
        "/home/dev/code/thing",
      );
    });

    fireEvent.click(screen.getByText("Open this folder"));

    // The folder you are IN, not one you selected in the list: walking into it
    // is the selection, which is how a folder chooser behaves everywhere else.
    await waitFor(() => {
      expect(api.openLocalFolderApi).toHaveBeenCalledWith(
        "/home/dev/code/thing",
      );
    });
    await waitFor(() => {
      expect(onOpened).toHaveBeenCalledWith({ id: "p1", name: "thing" });
    });
  });

  it("shows the server's refusal rather than a generic failure", async () => {
    api.openLocalFolderApi.mockRejectedValue({
      response: { data: { message: "That folder is already open as another project" } },
    });

    renderDialog();

    await waitFor(() => {
      expect(screen.getByText("thing")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Open this folder"));

    // The allowlist's refusals are the only explanation of why a path is not
    // openable, so swallowing them would leave somebody guessing at a rule
    // they cannot see.
    await waitFor(() => {
      expect(
        screen.getByText(/already open as another project/i),
      ).toBeTruthy();
    });
  });

  it("says these are the server's folders, not this computer's", async () => {
    renderDialog();

    await waitFor(() => {
      expect(screen.getByText("thing")).toBeTruthy();
    });

    // Not decoration. On a remote deployment these are a different machine's
    // directories, and somebody looking for their own laptop's ~/code would
    // otherwise read an empty list as a bug.
    expect(
      screen.getByText(/machine running this server, not on this computer/i),
    ).toBeTruthy();
  });
});

describe("the breadcrumb trail", () => {
  it("is derived from the two paths rather than accumulated", () => {
    // Derived, so it cannot drift from where the browse actually is -- the
    // same argument the keybinding registry makes about a chord and its label.
    expect(trailFor("/home/dev/code", "/home/dev/code/a/b")).toEqual([
      "/home/dev/code",
      "/home/dev/code/a",
      "/home/dev/code/a/b",
    ]);
  });

  it("is just the root when that is where the walk is", () => {
    expect(trailFor("/home/dev/code", "/home/dev/code")).toEqual([
      "/home/dev/code",
    ]);
  });

  it("does not invent a trail for a path outside the root", () => {
    expect(trailFor("/home/dev/code", "/etc")).toEqual(["/home/dev/code"]);
  });

  it("labels the root with its full path and everything else with a segment", () => {
    // "home" is not a location; /home/dev/code is.
    expect(labelFor("/home/dev/code", "/home/dev/code")).toBe("/home/dev/code");
    expect(labelFor("/home/dev/code/a/b", "/home/dev/code")).toBe("b");
  });
});
