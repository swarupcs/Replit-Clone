import { create } from "zustand";
import type { TreeNodeData } from "@replit-clone/shared";
import { queryClient } from "../config/queryClient.ts";
import { getProjectTree } from "../apis/projects.ts";

interface TreeStructureStore {
  projectId: string | null;
  treeStructure: TreeNodeData | null;
  /** relPaths of expanded folders. Lifted out of per-node state, which was
   *  keyed by name and so both collided and reset on every refetch. */
  expandedPaths: Set<string>;
  setProjectId: (projectId: string) => void;
  refreshTree: () => Promise<void>;
  toggleExpanded: (relPath: string) => void;
  collapseAll: () => void;
  /** Expands every folder on the path to `relPath` so a nested file can be
   *  revealed (used by the filter, which must show matches inside collapsed
   *  folders). */
  revealPath: (relPath: string) => void;
  /** Reveals many paths in ONE update.
   *
   *  Callers used to loop over `revealPath`, which is one store write — and so
   *  one render — per folder. React caps nested updates at 50, so a project
   *  with that many folders crashed the tree instead of filtering it. */
  revealPaths: (relPaths: string[]) => void;
  /** Restores a remembered set of open folders. */
  setExpandedPaths: (paths: string[]) => void;
}

export const useTreeStructureStore = create<TreeStructureStore>((set, get) => ({
  projectId: null,
  treeStructure: null,
  expandedPaths: new Set<string>(),

  setProjectId: (projectId) => set({ projectId }),

  refreshTree: async () => {
    const id = get().projectId;
    if (!id) return;

    const data = await queryClient.fetchQuery({
      queryKey: ["projectTree", id],
      queryFn: () => getProjectTree({ projectId: id }),
      staleTime: 0,
    });

    set({ treeStructure: data });
  },

  toggleExpanded: (relPath) =>
    set((state) => {
      const next = new Set(state.expandedPaths);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return { expandedPaths: next };
    }),

  collapseAll: () =>
    set((state) =>
      // Already empty: returning a fresh Set would still change identity, and
      // everything downstream keys off that.
      state.expandedPaths.size === 0
        ? state
        : { expandedPaths: new Set<string>() },
    ),

  setExpandedPaths: (paths) =>
    set((state) =>
      sameMembers(state.expandedPaths, paths)
        ? state
        : { expandedPaths: new Set(paths) },
    ),

  revealPath: (relPath) => get().revealPaths([relPath]),

  revealPaths: (relPaths) =>
    set((state) => {
      const next = new Set(state.expandedPaths);
      let added = false;

      for (const relPath of relPaths) {
        const segments = relPath.split("/");
        // Every ancestor, not just the immediate parent: "a/b/c.ts" needs both
        // "a" and "a/b" open for the row to be reachable.
        for (let i = 1; i < segments.length; i += 1) {
          const ancestor = segments.slice(0, i).join("/");
          if (!next.has(ancestor)) {
            next.add(ancestor);
            added = true;
          }
        }
      }

      // Nothing new to open. Returning the state unchanged keeps the Set's
      // identity, which is what stops a caller that reveals on every render
      // from re-rendering the tree forever.
      return added ? { expandedPaths: next } : state;
    }),
}));

/** Whether a Set already holds exactly these members. */
function sameMembers(current: Set<string>, paths: string[]): boolean {
  if (current.size !== paths.length) return false;
  return paths.every((path) => current.has(path));
}
