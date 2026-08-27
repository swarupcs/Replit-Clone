import { beforeEach, describe, expect, it } from "vitest";
import { usePresenceStore } from "./presenceStore.ts";
import type { Peer } from "../lib/collab.ts";

const peer = (key: string, files: string[] = ["a.ts"]): Peer => ({
  key,
  name: key,
  color: "#fff",
  files,
});

describe("follow mode", () => {
  beforeEach(() => {
    usePresenceStore.setState({ peers: [], colorsByFile: {}, following: null });
  });

  it("follows nobody to begin with", () => {
    expect(usePresenceStore.getState().following).toBeNull();
  });

  it("follows and unfollows", () => {
    usePresenceStore.getState().follow("alice");
    expect(usePresenceStore.getState().following).toBe("alice");

    usePresenceStore.getState().follow(null);
    expect(usePresenceStore.getState().following).toBeNull();
  });

  it("keeps following while they are here", () => {
    usePresenceStore.getState().setPresence([peer("alice")]);
    usePresenceStore.getState().follow("alice");
    usePresenceStore.getState().setPresence([peer("alice", ["b.ts"])]);

    expect(usePresenceStore.getState().following).toBe("alice");
  });

  /** Left set, the editor would sit waiting for a viewport that will never
   *  move again, and nothing would say why. */
  it("stops following someone who has left", () => {
    usePresenceStore.getState().setPresence([peer("alice"), peer("bob")]);
    usePresenceStore.getState().follow("alice");
    usePresenceStore.getState().setPresence([peer("bob")]);

    expect(usePresenceStore.getState().following).toBeNull();
  });

  it("does not confuse two people", () => {
    usePresenceStore.getState().setPresence([peer("alice"), peer("bob")]);
    usePresenceStore.getState().follow("bob");
    usePresenceStore.getState().setPresence([peer("alice")]);

    expect(usePresenceStore.getState().following).toBeNull();
  });

  /** The store short-circuits identical presence updates. That must not
   *  swallow the case where the only thing that changed is who is followed. */
  it("still clears a stale follow on an otherwise identical update", () => {
    const peers = [peer("alice")];
    usePresenceStore.getState().setPresence(peers);
    usePresenceStore.getState().follow("ghost");
    usePresenceStore.getState().setPresence(peers);

    expect(usePresenceStore.getState().following).toBeNull();
  });
});
