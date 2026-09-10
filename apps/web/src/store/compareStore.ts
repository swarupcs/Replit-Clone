import { create } from "zustand";

/** What the diff pane is comparing against. plan.md §10.11.
 *
 *  §10.11's complaint was that the editor could only diff a buffer against its
 *  own saved copy — "the thing you reach for at commit time and not the thing
 *  you reach for daily". So the left-hand side becomes a choice.
 *
 *  A store rather than a prop, because the thing that chooses is a dialog and
 *  the thing that renders is the editor, and neither owns the other.
 */
export type CompareAgainst =
  /** The file as saved. The behaviour that already existed, and the default. */
  | { kind: "saved" }
  /** The file as it stands on another branch, tag or commit. */
  | { kind: "ref"; ref: string }
  /** Another file in this project, as saved. */
  | { kind: "file"; relPath: string };

interface CompareStore {
  against: CompareAgainst;
  /** The left-hand text, once fetched. Null while loading or when the source is
   *  the saved copy, which the editor already has. */
  left: string | null;
  /** Set when the other side does not exist -- a file new on this branch. Shown
   *  rather than hidden: an empty left pane with no explanation reads as a
   *  failure to load. */
  missing: boolean;
  loading: boolean;
  setAgainst: (against: CompareAgainst) => void;
  setLeft: (left: string | null, missing: boolean) => void;
  setLoading: (loading: boolean) => void;
  reset: () => void;
}

export const useCompareStore = create<CompareStore>((set) => ({
  against: { kind: "saved" },
  left: null,
  missing: false,
  loading: false,
  setAgainst: (against) => {
    // The old text is dropped as the source changes, not when the new one
    // arrives: showing the previous comparison's left side against this file
    // would be a diff of two unrelated things, briefly, and briefly is enough
    // to be believed.
    set({ against, left: null, missing: false });
  },
  setLeft: (left, missing) => {
    set({ left, missing });
  },
  setLoading: (loading) => {
    set({ loading });
  },
  reset: () => {
    set({ against: { kind: "saved" }, left: null, missing: false, loading: false });
  },
}));

/** How to describe what is on the left, for the pane's own header. */
export function describeCompare(against: CompareAgainst): string {
  if (against.kind === "saved") return "the saved file";
  if (against.kind === "ref") return against.ref;
  return against.relPath;
}
