import { create } from "zustand";

interface FileContextMenuStore {
  x: number | null;
  y: number | null;
  isOpen: boolean;
  /** Path of the file the menu was opened on. */
  file: string | null;
  setX: (x: number | null) => void;
  setY: (y: number | null) => void;
  setIsOpen: (isOpen: boolean) => void;
  setFile: (file: string | null) => void;
}

export const useFileContextMenuStore = create<FileContextMenuStore>((set) => ({
  x: null,
  y: null,
  isOpen: false,
  file: null,
  setX: (x) => set({ x }),
  setY: (y) => set({ y }),
  setIsOpen: (isOpen) => set({ isOpen }),
  setFile: (file) => set({ file }),
}));
