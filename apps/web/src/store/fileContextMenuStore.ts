import { create } from "zustand";
import type { TreeNodeData } from "@replit-clone/shared";

interface FileContextMenuStore {
  x: number;
  y: number;
  isOpen: boolean;
  /** The node the menu was opened on. */
  node: TreeNodeData | null;
  open: (x: number, y: number, node: TreeNodeData) => void;
  close: () => void;
}

export const useFileContextMenuStore = create<FileContextMenuStore>((set) => ({
  x: 0,
  y: 0,
  isOpen: false,
  node: null,
  open: (x, y, node) => set({ x, y, node, isOpen: true }),
  close: () => set({ isOpen: false, node: null }),
}));
