import { create } from "zustand";

interface TerminalSocketStore {
  terminalSocket: WebSocket | null;
  setTerminalSocket: (socket: WebSocket | null) => void;
}

export const useTerminalSocketStore = create<TerminalSocketStore>((set) => ({
  terminalSocket: null,
  setTerminalSocket: (terminalSocket) => set({ terminalSocket }),
}));
