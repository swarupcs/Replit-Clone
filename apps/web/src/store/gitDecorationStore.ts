import { create } from "zustand";
import type { GitChange, GitChangeState } from "@replit-clone/shared";

/** How a path should read in the tree.
 *
 *  One state per path, not two. `GitChange` carries a staged and an unstaged
 *  side, and a row has one colour — so the unstaged side wins where both are
 *  set, because that is the change the file on disk actually has and the one
 *  someone scanning the tree is looking for.
 */
export type DecorationState = GitChangeState;

export interface Decoration {
  state: DecorationState;
  /** The single letter VS Code puts at the end of the row. */
  letter: string;
}

const LETTERS: Record<DecorationState, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

/** Which state matters more when a folder has to summarise its contents.
 *
 *  A folder shows the most consequential thing inside it: a modification is
 *  more worth surfacing than a file git has never seen, because the untracked
 *  file is probably build output and the modification is probably work. */
const RANK: Record<DecorationState, number> = {
  deleted: 5,
  modified: 4,
  renamed: 3,
  added: 2,
  untracked: 1,
};

interface GitDecorationStore {
  /** Keyed by POSIX path relative to the project root. Files only — folders
   *  are derived, because storing them would mean keeping two things in step
   *  every time a file's state changed. */
  byPath: Record<string, Decoration>;
  setChanges: (changes: GitChange[]) => void;
  clear: () => void;
}

export const useGitDecorationStore = create<GitDecorationStore>((set) => ({
  byPath: {},

  setChanges: (changes) => {
    const byPath: Record<string, Decoration> = {};

    for (const change of changes) {
      const state = change.unstaged ?? change.staged;
      if (!state) continue;
      byPath[change.path] = { state, letter: LETTERS[state] };
    }

    set({ byPath });
  },

  clear: () => set({ byPath: {} }),
}));

/** A file's own decoration, if it has one. */
export const selectDecoration =
  (relPath: string) =>
  (state: GitDecorationStore): Decoration | undefined =>
    state.byPath[relPath];

/** What a folder inherits from the files under it.
 *
 *  §1.5 is the reason this exists: a collapsed folder containing a change
 *  shows the tint in VS Code, and that is what makes a change findable
 *  without expanding anything.
 *
 *  Derived on read rather than stored. The alternative — precomputing a
 *  folder map when the status arrives — is a second copy of the same fact,
 *  and the two would drift the first time a path was added by any route that
 *  did not remember to update both.
 */
export const selectFolderDecoration =
  (relPath: string) =>
  (state: GitDecorationStore): Decoration | undefined => {
    const prefix = `${relPath}/`;
    let best: Decoration | undefined;

    for (const [path, decoration] of Object.entries(state.byPath)) {
      if (!path.startsWith(prefix)) continue;
      if (!best || RANK[decoration.state] > RANK[best.state]) best = decoration;
    }

    // A folder gets the colour but never the letter: a row saying "M" for
    // something several levels down would be claiming the folder itself
    // changed.
    return best ? { state: best.state, letter: "" } : undefined;
  };
