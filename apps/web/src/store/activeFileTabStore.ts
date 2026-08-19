import { create } from "zustand";

export interface ActiveFileTab {
  path: string;
  value: string;
  extension: string | undefined;
}

interface ActiveFileTabStore {
  activeFileTab: ActiveFileTab | null;
  setActiveFileTab: (
    path: string,
    value: string,
    extension: string | undefined,
  ) => void;
}

export const useActiveFileTabStore = create<ActiveFileTabStore>((set) => ({
  activeFileTab: null,
  setActiveFileTab: (path, value, extension) => {
    set({ activeFileTab: { path, value, extension } });
  },
}));
