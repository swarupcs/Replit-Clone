import { create } from "zustand";
import type { TreeNodeData } from "@replit-clone/shared";
import { queryClient } from "../config/queryClient.ts";
import { getProjectTree } from "../apis/projects.ts";

interface TreeStructureStore {
  projectId: string | null;
  treeStructure: TreeNodeData | null;
  setProjectId: (projectId: string) => void;
  /** Refetches the tree for the current projectId. */
  setTreeStructure: () => Promise<void>;
}

export const useTreeStructureStore = create<TreeStructureStore>((set, get) => ({
  projectId: null,
  treeStructure: null,
  setProjectId: (projectId) => set({ projectId }),
  setTreeStructure: async () => {
    const id = get().projectId;
    if (!id) return;

    const data = await queryClient.fetchQuery({
      queryKey: ["projectTree", id],
      queryFn: () => getProjectTree({ projectId: id }),
    });

    set({ treeStructure: data });
  },
}));
