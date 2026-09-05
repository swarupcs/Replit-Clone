import { beforeEach, describe, expect, it } from "vitest";
import {
  selectCanReachServer,
  selectConnectionNotice,
  useConnectionStore,
} from "./connectionStore.ts";

/** Whether this editor can reach its server, and what to say about it.
 *
 *  The reason these are two facts rather than one: `navigator.onLine` is a
 *  claim about the network interface, not about this server. It goes false in
 *  a tunnel and stays true on hotel wifi that has stopped routing. Conflating
 *  them gives the wrong message in both directions, and both directions are
 *  tested below.
 */

function set(patch: {
  online?: boolean;
  socket?: "connecting" | "connected" | "reconnecting" | "closed";
  queued?: number;
}): void {
  const store = useConnectionStore.getState();
  if (patch.online !== undefined) store.setOnline(patch.online);
  if (patch.socket !== undefined) store.setSocketState(patch.socket);
  if (patch.queued !== undefined) store.setQueuedWrites(patch.queued);
}

beforeEach(() => {
  useConnectionStore.setState({
    online: true,
    socket: "connecting",
    lastConnectedAt: null,
    queuedWrites: 0,
  });
});

describe("whether work can reach the server", () => {
  it("needs both the network and the socket", () => {
    set({ online: true, socket: "connected" });
    expect(selectCanReachServer(useConnectionStore.getState())).toBe(true);

    set({ socket: "reconnecting" });
    expect(selectCanReachServer(useConnectionStore.getState())).toBe(false);

    set({ online: false, socket: "connected" });
    expect(selectCanReachServer(useConnectionStore.getState())).toBe(false);
  });

  /** For "last saved N minutes ago", and stamped only by a good connection. */
  it("remembers when it was last connected", () => {
    expect(useConnectionStore.getState().lastConnectedAt).toBeNull();

    set({ socket: "connected" });
    expect(useConnectionStore.getState().lastConnectedAt).not.toBeNull();

    const stamp = useConnectionStore.getState().lastConnectedAt;
    set({ socket: "reconnecting" });
    // A disconnection does not move it — it is the last time things WERE fine.
    expect(useConnectionStore.getState().lastConnectedAt).toBe(stamp);
  });
});

describe("what it says", () => {
  /** Every page load passes through connecting, and a banner on every load is
   *  a banner nobody reads by the second day. */
  it("says nothing while merely connecting", () => {
    set({ online: true, socket: "connecting" });
    expect(selectConnectionNotice(useConnectionStore.getState())).toBeNull();
  });

  it("says nothing when everything is fine", () => {
    set({ online: true, socket: "connected" });
    expect(selectConnectionNotice(useConnectionStore.getState())).toBeNull();
  });

  it("reports being offline", () => {
    set({ online: false, socket: "connected" });

    const notice = selectConnectionNotice(useConnectionStore.getState());
    expect(notice?.tone).toBe("warning");
    expect(notice?.text).toMatch(/offline/i);
  });

  /** "Unsaved" and "unsaved and unsendable" are different states, and only one
   *  of them is somebody's problem. */
  it("counts the writes that are waiting", () => {
    set({ online: false, queued: 3 });

    expect(selectConnectionNotice(useConnectionStore.getState())?.text).toMatch(
      /3 unsaved changes are being kept/,
    );
  });

  it("gets the singular right for one", () => {
    set({ online: false, queued: 1 });

    expect(selectConnectionNotice(useConnectionStore.getState())?.text).toMatch(
      /1 unsaved change is being kept/,
    );
  });

  /** socket.io retries on its own, so this is a warning rather than an error:
   *  it usually resolves itself and nobody needs to act. */
  it("treats reconnecting as a warning, not a failure", () => {
    set({ online: true, socket: "reconnecting" });

    const notice = selectConnectionNotice(useConnectionStore.getState());
    expect(notice?.tone).toBe("warning");
    expect(notice?.text).toMatch(/Reconnecting/);
  });

  /** The server hung up deliberately, which socket.io does not retry. This is
   *  the one case somebody has to act on. */
  it("treats a closed connection as an error", () => {
    set({ online: true, socket: "closed" });

    const notice = selectConnectionNotice(useConnectionStore.getState());
    expect(notice?.tone).toBe("error");
    expect(notice?.text).toMatch(/Disconnected/);
  });

  /** Being offline is the more actionable of the two, so it wins: telling
   *  somebody on a train that the server hung up sends them looking at the
   *  wrong thing. */
  it("prefers the offline message when both are true", () => {
    set({ online: false, socket: "closed" });

    expect(selectConnectionNotice(useConnectionStore.getState())?.text).toMatch(
      /offline/i,
    );
  });
});
