// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

const settled = vi.hoisted(() => ({ resolve: () => {}, promise: Promise.resolve() }));

vi.mock("../lib/sessionSync.ts", () => ({
  whenSessionSettled: () => settled.promise,
}));

import { useWorkspaceSession } from "./useWorkspaceSession.ts";
import { useWorkspaceStore } from "../store/workspaceStore.ts";
import { useOpenTabsStore } from "../store/openTabsStore.ts";
import type { EditorSocket } from "../store/editorSocketStore.ts";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function fakeSocket() {
  const emit = vi.fn();
  return { socket: { emit } as unknown as EditorSocket, emit };
}

function opened(emit: ReturnType<typeof vi.fn>): string[] {
  return emit.mock.calls
    .filter(([event]) => event === "readFile")
    .map(([, payload]) => (payload as { relPath: string }).relPath);
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ sessions: {} });
  useOpenTabsStore.setState({ tabs: [], activeRelPath: null });
  settled.promise = new Promise<void>((resolve) => {
    settled.resolve = resolve;
  });
});

afterEach(() => {
  cleanup();
});

describe("coming back to the arrangement you left", () => {
  it("reopens the files that were open", async () => {
    useWorkspaceStore.getState().merge(PROJECT, {
      openPaths: ["a.ts", "b.ts"],
      activeRelPath: "a.ts",
      expandedPaths: [],
    });

    const { socket, emit } = fakeSocket();
    renderHook(() => useWorkspaceSession(PROJECT, socket));
    settled.resolve();

    // The active file last, so it ends up focused after the others.
    await waitFor(() => {
      expect(opened(emit)).toEqual(["b.ts", "a.ts"]);
    });
  });

  it("waits for the account's session before deciding there is nothing", async () => {
    // A machine that has never opened this project: nothing in localStorage,
    // and the account's layout still in flight. plan.md §13.11.
    const { socket, emit } = fakeSocket();
    renderHook(() => useWorkspaceSession(PROJECT, socket));

    expect(opened(emit)).toEqual([]);

    useWorkspaceStore.getState().merge(PROJECT, {
      openPaths: ["pulled.ts"],
      activeRelPath: "pulled.ts",
      expandedPaths: [],
    });
    settled.resolve();

    // Without the wait, whether the second machine comes back to your tabs
    // depends on which of two round trips wins.
    await waitFor(() => {
      expect(opened(emit)).toEqual(["pulled.ts"]);
    });
  });

  it("does nothing when there is nothing to restore", async () => {
    const { socket, emit } = fakeSocket();
    renderHook(() => useWorkspaceSession(PROJECT, socket));
    settled.resolve();
    await settled.promise;

    expect(opened(emit)).toEqual([]);
  });

  it("restores once, not on every render", async () => {
    useWorkspaceStore.getState().merge(PROJECT, {
      openPaths: ["a.ts"],
      activeRelPath: "a.ts",
      expandedPaths: [],
    });

    const { socket, emit } = fakeSocket();
    const { rerender } = renderHook(() => useWorkspaceSession(PROJECT, socket));
    settled.resolve();
    await waitFor(() => {
      expect(opened(emit)).toHaveLength(1);
    });

    rerender();
    await Promise.resolve();

    // Re-emitting readFile would refetch every open buffer from the server and
    // throw away whatever was unsaved in it.
    expect(opened(emit)).toHaveLength(1);
  });

  it("does not throw the page away over an unreadable session", async () => {
    // This runs above every panel-level error boundary, so a throw here used
    // to be "Something broke" for the whole IDE.
    useWorkspaceStore.setState({
      sessions: {
        [PROJECT]: { openPaths: ["a.ts"], activeRelPath: null, expandedPaths: [] },
      },
    });

    const { socket, emit } = fakeSocket();
    emit.mockImplementationOnce(() => {
      throw new Error("socket is gone");
    });

    renderHook(() => useWorkspaceSession(PROJECT, socket));
    settled.resolve();
    await settled.promise;

    // Nothing to assert beyond having got here without an unhandled throw.
    expect(true).toBe(true);
  });
});
