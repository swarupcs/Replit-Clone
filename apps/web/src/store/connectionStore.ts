import { create } from "zustand";

/** Whether this editor can currently reach its server. plan.md §11.7.
 *
 *  Nothing tracked this before. `pendingWrites` dropped a queued write with
 *  `emit?.(...)` when there was no socket — the optional call was doing the
 *  work of an error handler — and the tab stayed marked unsaved, which is the
 *  only reason it was survivable at all. Nobody was told.
 *
 *  **Two different facts, kept apart on purpose.** The browser being offline
 *  is `navigator.onLine`, and it is a hint about the network interface rather
 *  than about this server: it goes false in a tunnel and stays true on hotel
 *  wifi that has stopped routing. The socket being down is what actually
 *  decides whether an edit can be saved. Conflating them would give the wrong
 *  message in both directions — "you are offline" on a working machine whose
 *  server has restarted, and nothing at all on a captive portal.
 */
export type SocketState = "connecting" | "connected" | "reconnecting" | "closed";

interface ConnectionStore {
  /** What the browser thinks of the network interface. */
  online: boolean;
  /** What the editor socket is actually doing. */
  socket: SocketState;
  /** When the connection was last known good, for "last saved 3 minutes ago". */
  lastConnectedAt: number | null;
  /** How many writes are waiting for the connection to come back. Surfaced
   *  because "unsaved" and "unsaved and unsendable" are different states and
   *  only one of them is somebody's problem. */
  queuedWrites: number;

  setOnline: (online: boolean) => void;
  setSocketState: (state: SocketState) => void;
  setQueuedWrites: (count: number) => void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  // `navigator.onLine` is true in every environment that does not implement
  // it, which is the right default: assuming offline would show a warning on
  // a machine that is fine.
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  socket: "connecting",
  lastConnectedAt: null,
  queuedWrites: 0,

  setOnline: (online) => set({ online }),
  setSocketState: (state) =>
    set(
      state === "connected"
        ? { socket: state, lastConnectedAt: Date.now() }
        : { socket: state },
    ),
  setQueuedWrites: (queuedWrites) => set({ queuedWrites }),
}));

/** Whether work can currently reach the server.
 *
 *  A selector rather than a stored boolean, so the two facts above cannot
 *  drift apart from the conclusion drawn from them.
 */
export function selectCanReachServer(state: ConnectionStore): boolean {
  return state.online && state.socket === "connected";
}

/** What to tell somebody, or null when there is nothing worth saying.
 *
 *  Deliberately quiet while merely *connecting*: every page load passes
 *  through that state, and a banner on every load is a banner nobody reads by
 *  the second day.
 */
export function selectConnectionNotice(
  state: ConnectionStore,
): { tone: "warning" | "error"; text: string } | null {
  if (!state.online) {
    return {
      tone: "warning",
      text:
        state.queuedWrites > 0
          ? `You are offline. ${String(state.queuedWrites)} unsaved ${
              state.queuedWrites === 1 ? "change is" : "changes are"
            } being kept and will be sent when the connection returns.`
          : "You are offline. Edits are kept here until the connection returns.",
    };
  }

  if (state.socket === "reconnecting") {
    return {
      tone: "warning",
      text: "Reconnecting to the server. Your edits are being kept.",
    };
  }

  if (state.socket === "closed") {
    return {
      tone: "error",
      text: "Disconnected from the server. Your edits are kept here — reload once the connection is back.",
    };
  }

  return null;
}

/** Starts watching the browser's own online/offline events.
 *
 *  Returns a teardown, and is called once from the app root rather than from a
 *  panel: these are window events and two listeners would be two updates for
 *  one change.
 */
export function watchNetwork(): () => void {
  const { setOnline } = useConnectionStore.getState();

  const goOnline = (): void => {
    setOnline(true);
  };
  const goOffline = (): void => {
    setOnline(false);
  };

  window.addEventListener("online", goOnline);
  window.addEventListener("offline", goOffline);

  // Read once on the way in as well: the app can mount while already offline,
  // and neither event fires for a state that did not change.
  setOnline(navigator.onLine);

  return () => {
    window.removeEventListener("online", goOnline);
    window.removeEventListener("offline", goOffline);
  };
}
