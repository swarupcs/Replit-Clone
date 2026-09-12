import { create } from "zustand";

/** Whether blame annotations are shown. plan.md §10.13.
 *
 *  A store rather than editor state, because the thing that turns it on is the
 *  command palette and the thing that reads it is the editor, and those are far
 *  apart in the tree.
 *
 *  Deliberately NOT persisted. Blame runs `git blame` in the container for
 *  every file you open, and a preference that quietly survives a reload would
 *  mean somebody who tried it once pays for it forever without remembering
 *  they asked.
 */
interface BlameStore {
  enabled: boolean;
  toggle: () => void;
}

export const useBlameStore = create<BlameStore>((set) => ({
  enabled: false,
  toggle: () => {
    set((state) => ({ enabled: !state.enabled }));
  },
}));
