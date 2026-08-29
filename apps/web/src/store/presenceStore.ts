import { create } from "zustand";
import type { Peer } from "../lib/collab.ts";

interface PresenceStore {
  /** Everyone else in the project, folded across documents. */
  peers: Peer[];
  /** relPath → the colours of the people in it, comma-joined.
   *
   *  A string rather than an array of peers, because this is read by a file
   *  tree row and by a tab — hundreds of subscribers, one per file. A selector
   *  returning an array hands each of them a new identity on every awareness
   *  update and re-renders the whole tree; a string compares by value, so a
   *  row only re-renders when the people in *its* file change.
   */
  colorsByFile: Record<string, string>;

  /** Whose viewport this editor is riding along with, by peer key.
   *
   *  Follow mode. Presence already knows who is here and which file they
   *  are in; following is a small addition to a layer that exists rather
   *  than a new one. */
  following: string | null;

  setPresence: (peers: Peer[]) => void;
  follow: (peerKey: string | null) => void;
}

function colorsFrom(peers: Peer[]): Record<string, string> {
  const byFile = new Map<string, string[]>();

  for (const peer of peers) {
    for (const file of peer.files) {
      const existing = byFile.get(file);
      if (existing) existing.push(peer.color);
      else byFile.set(file, [peer.color]);
    }
  }

  return Object.fromEntries(
    [...byFile].map(([file, colors]) => [file, colors.join(",")]),
  );
}

/** True when nothing anyone would see has changed. */
function same(a: Peer[], b: Peer[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((peer, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      peer.key === other.key &&
      peer.color === other.color &&
      peer.files.length === other.files.length &&
      peer.files.every((file, at) => file === other.files[at])
    );
  });
}

export const usePresenceStore = create<PresenceStore>((set) => ({
  peers: [],
  colorsByFile: {},
  following: null,

  follow: (peerKey) => set({ following: peerKey }),

  setPresence: (peers) =>
    set((state) => {
      // Someone who has left cannot be followed. Left set, the editor would
      // sit waiting for a viewport that will never move again, and nothing
      // would say why.
      const following =
        state.following && peers.some((peer) => peer.key === state.following)
          ? state.following
          : null;

      return (
      // Awareness fires for a cursor move as well as for someone arriving, and
      // a cursor move changes nothing here.
        same(state.peers, peers) && following === state.following
          ? state
          : { peers, colorsByFile: colorsFrom(peers), following }
      );
    }),
}));

/** The colours in one file, or "" — a value a row can compare cheaply. */
export const selectFileColors =
  (relPath: string) =>
  (state: PresenceStore): string =>
    state.colorsByFile[relPath] ?? "";
