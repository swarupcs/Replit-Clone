// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorSessionState } from "@replit-clone/shared";

const getSession = vi.fn();
const setSession = vi.fn();

vi.mock("../apis/projects.ts", () => ({
  getEditorSessionApi: () => getSession() as unknown,
  setEditorSessionApi: (entries: Record<string, unknown>) =>
    setSession(entries) as unknown,
}));

import {
  forgetSeenRevs,
  pullSession,
  resetSessionSyncForTests,
  startSessionSync,
} from "./sessionSync.ts";
import { useThemeStore } from "../store/themeStore.ts";
import { useEditorSettingsStore } from "../store/editorSettingsStore.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function server(entries: EditorSessionState["entries"]): EditorSessionState {
  return { entries };
}

function stored(value: unknown, rev = 1) {
  return { value, rev, updatedAt: "2026-09-09T10:00:00.000Z" };
}

/** What zustand's `persist` actually writes: the partialized state under a
 *  `state` key, beside the store's version. Syncing the envelope rather than
 *  the state alone is what lets a store grow a migration and have it apply to
 *  a pulled value too. */
function envelope(state: unknown) {
  return { state, version: 0 };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  getSession.mockReset().mockResolvedValue(server({}));
  setSession.mockReset().mockResolvedValue(server({}));
  useThemeStore.setState({ choice: "system" });
  useEditorSettingsStore.getState().reset();

  // AFTER the resets, not before: `persist` writes on every setState, so
  // seeding a store leaves a value in storage and the browser would look to
  // the sync layer like one that has settings worth uploading. The baseline
  // these tests want is a browser that has stored nothing.
  localStorage.clear();
});

afterEach(() => {
  resetSessionSyncForTests();
  vi.useRealTimers();
});

describe("taking the account's session", () => {
  it("applies a value this browser has never seen", async () => {
    getSession.mockResolvedValue(
      server({ "rc-theme": stored(envelope({ choice: "dark" })) }),
    );

    await pullSession();

    // The whole point of the row: a second machine opens on the settings the
    // person actually uses.
    expect(useThemeStore.getState().choice).toBe("dark");
  });

  it("leaves alone a key the server has nothing for", async () => {
    useThemeStore.setState({ choice: "light" });
    await pullSession();

    expect(useThemeStore.getState().choice).toBe("light");
  });

  it("does not overwrite a change made on this machine", async () => {
    startSessionSync(USER);
    await vi.runOnlyPendingTimersAsync();

    // Somebody changing a setting in the second before a slow pull returns
    // must not watch it snap back: their change is newer than anything the
    // pull can know about.
    useThemeStore.getState().setChoice("light");

    getSession.mockResolvedValue(
      server({ "rc-theme": stored(envelope({ choice: "dark" })) }),
    );
    await pullSession();

    expect(useThemeStore.getState().choice).toBe("light");
  });

  it("skips a revision it has already applied", async () => {
    getSession.mockResolvedValue(
      server({ "rc-theme": stored(envelope({ choice: "dark" }), 5) }),
    );
    await pullSession();

    // Locally diverged afterwards, without going through the sync layer.
    useThemeStore.setState({ choice: "light" });
    await pullSession();

    // Re-applying our own last write is not wrong, only a pointless re-render
    // of everything subscribed -- and here it would also undo a local change
    // this browser made after seeing that same revision.
    expect(useThemeStore.getState().choice).toBe("light");
  });

  it("keeps what this browser has when the request fails", async () => {
    useThemeStore.setState({ choice: "light" });
    getSession.mockRejectedValue(new Error("offline"));

    // Signed out, offline, or a server older than this endpoint. All three are
    // the behaviour that existed before §13.11, which is a working editor.
    await expect(pullSession()).resolves.toBeUndefined();
    expect(useThemeStore.getState().choice).toBe("light");
  });

  it("pulls again for the next account after the revisions are forgotten", async () => {
    getSession.mockResolvedValue(
      server({ "rc-theme": stored(envelope({ choice: "dark" }), 5) }),
    );
    await pullSession();

    forgetSeenRevs();
    useThemeStore.setState({ choice: "system" });
    await pullSession();

    // Revisions are per account. A browser carrying the previous account's
    // numbers would decide the new account's session was one it had applied.
    expect(useThemeStore.getState().choice).toBe("dark");
  });
});

describe("a browser two people share", () => {
  it("does not show the previous account its predecessor's session", async () => {
    startSessionSync(USER);
    await vi.runOnlyPendingTimersAsync();
    useThemeStore.getState().setChoice("dark");
    await vi.advanceTimersByTimeAsync(2000);
    resetSessionSyncForTests();

    setSession.mockClear();
    startSessionSync(OTHER);
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(2000);

    // Reset in memory as well as in storage: `rehydrate` with nothing stored
    // leaves the live state exactly as it is, which here would be the previous
    // account's.
    expect(useThemeStore.getState().choice).toBe("system");

    // And certainly not uploaded into the second person's account.
    expect(setSession).not.toHaveBeenCalled();
  });

  it("keeps the session when the same account signs in again", async () => {
    startSessionSync(USER);
    await vi.runOnlyPendingTimersAsync();
    useThemeStore.getState().setChoice("dark");
    await vi.advanceTimersByTimeAsync(2000);
    resetSessionSyncForTests();

    startSessionSync(USER);
    await vi.runOnlyPendingTimersAsync();

    expect(useThemeStore.getState().choice).toBe("dark");
  });
});

describe("sending what changed", () => {
  it("sends only the store that changed", async () => {
    startSessionSync(USER);
    await vi.runOnlyPendingTimersAsync();
    setSession.mockClear();

    useThemeStore.getState().setChoice("dark");
    await vi.advanceTimersByTimeAsync(2000);

    expect(setSession).toHaveBeenCalledTimes(1);
    // Two machines changing different things are not writing the same row, so
    // neither overwrites the other. Sending every key would give that up.
    expect(Object.keys(setSession.mock.calls[0]?.[0] as object)).toEqual([
      "rc-theme",
    ]);
  });

  it("collapses a burst into one request", async () => {
    startSessionSync(USER);
    await vi.runOnlyPendingTimersAsync();
    setSession.mockClear();

    // Dragging a divider fires a change per animation frame.
    const settings = useEditorSettingsStore.getState();
    settings.set("fontSize", 15);
    settings.set("fontSize", 16);
    settings.set("fontSize", 17);
    await vi.advanceTimersByTimeAsync(2000);

    expect(setSession).toHaveBeenCalledTimes(1);
  });

  it("sends nothing while only reading", async () => {
    startSessionSync(USER);
    await vi.advanceTimersByTimeAsync(5000);

    expect(setSession).not.toHaveBeenCalled();
  });

  it("does not send back a value it has just pulled", async () => {
    getSession.mockResolvedValue(
      server({ "rc-theme": stored(envelope({ choice: "dark" })) }),
    );

    startSessionSync(USER);
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(2000);

    // Accepting the server's value is a change to the store, and a subscriber
    // that could not tell the two apart would push it straight back -- one
    // request per machine per sign-in, forever.
    expect(setSession).not.toHaveBeenCalled();
  });

  it("keeps working after a failed save", async () => {
    startSessionSync(USER);
    await vi.runOnlyPendingTimersAsync();
    setSession.mockClear().mockRejectedValueOnce(new Error("down"));

    useThemeStore.getState().setChoice("dark");
    await vi.advanceTimersByTimeAsync(2000);

    setSession.mockResolvedValue(server({}));
    useThemeStore.getState().setChoice("light");
    await vi.advanceTimersByTimeAsync(2000);

    // Not retried, because the next change sends the whole value again -- so
    // one failed save costs nothing beyond itself, and there is no loop
    // hammering a server that is down.
    expect(setSession).toHaveBeenCalledTimes(2);
    expect(setSession.mock.calls[1]?.[0]).toEqual({
      "rc-theme": envelope({ choice: "light" }),
    });
  });

  it("subscribes once however many times it is started", async () => {
    // React's StrictMode mounts the tree twice.
    startSessionSync(USER);
    startSessionSync(USER);
    await vi.runOnlyPendingTimersAsync();
    setSession.mockClear();

    useThemeStore.getState().setChoice("dark");
    await vi.advanceTimersByTimeAsync(2000);

    expect(setSession).toHaveBeenCalledTimes(1);
  });

  it("uploads what this browser has when the account has nothing", async () => {
    // The FIRST machine. It changes nothing after signing in, so without this
    // nothing is ever pushed -- and the second machine finds an empty account
    // and concludes the person has no settings.
    useThemeStore.getState().setChoice("dark");

    startSessionSync(USER);
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(2000);

    expect(setSession).toHaveBeenCalledWith({
      "rc-theme": envelope({ choice: "dark" }),
    });
  });

  it("does not upload over a value the account already has", async () => {
    useThemeStore.getState().setChoice("dark");
    getSession.mockResolvedValue(
      server({ "rc-theme": stored(envelope({ choice: "light" })) }),
    );

    startSessionSync(USER);
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(2000);

    // Another machine stored that. Adopting this browser's copy over it would
    // make "whichever machine you signed in on last" the winner rather than
    // "whichever change you made last".
    expect(setSession).not.toHaveBeenCalled();
    expect(useThemeStore.getState().choice).toBe("light");
  });

  it("flushes a pending change when the tab is hidden", async () => {
    startSessionSync(USER);
    await vi.runOnlyPendingTimersAsync();
    setSession.mockClear();

    useThemeStore.getState().setChoice("dark");

    // The moment somebody's last change is most likely to be sitting in the
    // debounce window.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);

    expect(setSession).toHaveBeenCalledTimes(1);
  });
});
