// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { DeploymentRelease } from "@replit-clone/shared";

/** Previous builds, and going back to one.
 *
 *  The thing people get wrong about a rollback is thinking it rebuilds. It
 *  does not — each build kept its own files and the deployment points at the
 *  live one — so the panel has to say so where somebody is about to click.
 */
const listReleases = vi.fn();
const rollback = vi.fn();

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return { ...actual, message: toast };
});

vi.mock("../../../apis/deployments.ts", () => ({
  listReleasesApi: (projectId: string) => listReleases(projectId) as unknown,
  rollbackApi: (projectId: string, releaseId: string) =>
    rollback(projectId, releaseId) as unknown,
}));

import { ReleaseHistory } from "./ReleaseHistory.tsx";

const release = (
  id: string,
  live: boolean,
  minutesAgo: number,
): DeploymentRelease => ({
  id,
  kind: "static",
  buildCommand: "npm run build",
  outputDir: "dist",
  sizeBytes: 2048,
  log: "",
  createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  live,
});

const TWO = [release("r2", true, 5), release("r1", false, 90)];

const show = (isOwner = true) =>
  render(<ReleaseHistory projectId="p1" isOwner={isOwner} />);

beforeEach(() => {
  listReleases.mockReset().mockResolvedValue(TWO);
  rollback.mockReset().mockResolvedValue([
    release("r2", false, 5),
    release("r1", true, 90),
  ]);
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(cleanup);

describe("showing the history", () => {
  it("lists the builds and marks the one being served", async () => {
    show();

    expect(await screen.findByText("serving")).toBeTruthy();
    expect(screen.getByText("5m ago")).toBeTruthy();
    expect(screen.getByText("2h ago")).toBeTruthy();
  });

  it("shows nothing at all until there is something to go back to", async () => {
    // One build IS the live one. A history of one entry is a list that only
    // takes up room.
    listReleases.mockResolvedValue([release("r1", true, 5)]);
    const { container } = show();

    await waitFor(() => {
      expect(listReleases).toHaveBeenCalled();
    });
    expect(container.querySelector(".rc-releases")).toBeNull();
  });

  it("stays quiet when there is no deployment at all", async () => {
    listReleases.mockRejectedValue(new Error("no deployment"));
    const { container } = show();

    await waitFor(() => {
      expect(listReleases).toHaveBeenCalled();
    });
    expect(container.querySelector(".rc-releases")).toBeNull();
    // Not a toast: somebody opened this panel to do something else.
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("rolling back", () => {
  it("offers it only on builds that are not already serving", async () => {
    show();

    expect(
      await screen.findByLabelText("Roll back to the build from 2h ago"),
    ).toBeTruthy();
    expect(
      screen.queryByLabelText("Roll back to the build from 5m ago"),
    ).toBeNull();
  });

  it("promises it will not rebuild, where somebody is about to click", async () => {
    show();

    fireEvent.click(
      await screen.findByLabelText("Roll back to the build from 2h ago"),
    );

    expect(
      await screen.findByText(/still here, so nothing is rebuilt/i),
    ).toBeTruthy();
  });

  it("rolls back once confirmed", async () => {
    show();

    fireEvent.click(
      await screen.findByLabelText("Roll back to the build from 2h ago"),
    );
    fireEvent.click(await screen.findByText("Roll back"));

    await waitFor(() => {
      expect(rollback).toHaveBeenCalledWith("p1", "r1");
    });
  });

  it("keeps the server's reason when it refuses", async () => {
    // "Only a static site can be rolled back" says what to do next.
    rollback.mockRejectedValue(
      new Error("Only a static site can be rolled back."),
    );
    show();

    fireEvent.click(
      await screen.findByLabelText("Roll back to the build from 2h ago"),
    );
    fireEvent.click(await screen.findByText("Roll back"));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Only a static site can be rolled back.",
      );
    });
  });
});

describe("a collaborator who is not the owner", () => {
  it("can read the history and cannot change what is served", async () => {
    show(false);

    expect(await screen.findByText("serving")).toBeTruthy();
    expect(
      screen.queryByLabelText("Roll back to the build from 2h ago"),
    ).toBeNull();
  });
});
