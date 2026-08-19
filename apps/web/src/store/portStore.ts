import { create } from "zustand";

interface PortStore {
  port: string | null;
  setPort: (port: string | null) => void;
}

export const usePortStore = create<PortStore>((set) => ({
  port: null,
  setPort: (port) => set({ port }),
}));
