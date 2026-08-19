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
}));
