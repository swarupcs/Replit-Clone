import { create } from "zustand";
import { getGitDiffApi } from "../apis/projects.ts";
import { gutterRegions, type GutterRegion } from "../lib/gitGutter.ts";

/** How long after the last edit the diff is asked for.
 *
 *  The patch comes from a `git diff` in the container, so this is a round
 *  trip through a subprocess and cannot run per keystroke. Long enough that
 *  typing a line does not queue a request per character, short enough that
 *  the bars have caught up by the time anyone looks at them. */
const DEBOUNCE_MS = 400;

interface GitGutterStore {
  /** Set once per project, because the editor does not otherwise know which
   *  project it is in and threading it down as a prop would touch four
   *  components to reach the one that needs it. */
  projectId: string | null;
  regionsByPath: Record<string, GutterRegion[]>;
  setProject: (projectId: string | null) => void;
  /** Asks for this file's diff, debounced. Safe to call on every keystroke. */
  refresh: (relPath: string) => void;
  forget: (relPath: string) => void;
  clear: () => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Rising counter per path, so a slow response for an old edit cannot
 *  overwrite the regions computed from a newer one. */
const generation = new Map<string, number>();

export const useGitGutterStore = create<GitGutterStore>((set, get) => ({
  projectId: null,
  regionsByPath: {},

  setProject: (projectId) => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    generation.clear();
    set({ projectId, regionsByPath: {} });
  },

  refresh: (relPath) => {
    const existing = timers.get(relPath);
    if (existing) clearTimeout(existing);

    timers.set(
      relPath,
      setTimeout(() => {
        timers.delete(relPath);

        const projectId = get().projectId;
        if (!projectId) return;

        const mine = (generation.get(relPath) ?? 0) + 1;
        generation.set(relPath, mine);

        void getGitDiffApi(projectId, relPath, false)
          .then((patch) => {
            // A newer edit has already asked; its answer is the current one.
            if (generation.get(relPath) !== mine) return;
            set((state) => ({
              regionsByPath: { ...state.regionsByPath, [relPath]: gutterRegions(patch) },
            }));
          })
          .catch(() => {
            // Not a repository, a file git has never seen, a container that
            // is not running: all ordinary, and all mean "no bars" rather
            // than an error worth putting in front of anyone.
            if (generation.get(relPath) !== mine) return;
            set((state) => ({
              regionsByPath: { ...state.regionsByPath, [relPath]: [] },
            }));
          });
      }, DEBOUNCE_MS),
    );
  },

  forget: (relPath) => {
    const timer = timers.get(relPath);
    if (timer) clearTimeout(timer);
    timers.delete(relPath);
    generation.delete(relPath);
    set((state) => {
      const { [relPath]: _dropped, ...rest } = state.regionsByPath;
      return { regionsByPath: rest };
    });
  },

  clear: () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    generation.clear();
    set({ regionsByPath: {} });
  },
}));

/** This file's regions, or none. A stable empty array so a subscriber does
 *  not re-render on every unrelated change to the map. */
const NONE: GutterRegion[] = [];
export const selectRegions =
  (relPath: string | null) =>
  (state: GitGutterStore): GutterRegion[] =>
    (relPath ? state.regionsByPath[relPath] : undefined) ?? NONE;
