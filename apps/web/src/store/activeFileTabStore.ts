import { create } from "zustand";
import { fileExtension } from "@replit-clone/shared";

export interface ActiveFileTab {
  /** POSIX path relative to the project root. */
  relPath: string;
  value: string;
  extension: string | undefined;
}

interface ActiveFileTabStore {
  activeFileTab: ActiveFileTab | null;
  setActiveFileTab: (relPath: string, value: string) => void;
  clearActiveFileTab: () => void;
}

export const useActiveFileTabStore = create<ActiveFileTabStore>((set) => ({
  activeFileTab: null,
  setActiveFileTab: (relPath, value) => {
    const name = relPath.split("/").pop() ?? relPath;
    set({ activeFileTab: { relPath, value, extension: fileExtension(name) } });
  },
  clearActiveFileTab: () => set({ activeFileTab: null }),
}));
