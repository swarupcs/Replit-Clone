import { create } from "zustand";
import type { Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@replit-clone/shared";
import { useActiveFileTabStore } from "./activeFileTabStore.ts";
import { useTreeStructureStore } from "./treeStructureStore.ts";
import { usePortStore } from "./portStore.ts";

export type EditorSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface EditorSocketStore {
  editorSocket: EditorSocket | null;
  setEditorSocket: (socket: EditorSocket | null) => void;
}

export const useEditorSocketStore = create<EditorSocketStore>((set) => ({
  editorSocket: null,
  setEditorSocket: (incomingSocket) => {
    if (!incomingSocket) {
      set({ editorSocket: null });
      return;
    }

    const setActiveFileTab = useActiveFileTabStore.getState().setActiveFileTab;
    const refreshTreeStructure =
      useTreeStructureStore.getState().setTreeStructure;
    const setPort = usePortStore.getState().setPort;

    incomingSocket.on("readFileSuccess", ({ path, value }) => {
      const fileExtension = path.split(".").pop();
      setActiveFileTab(path, value, fileExtension);
    });

    incomingSocket.on("deleteFileSuccess", () => {
      void refreshTreeStructure();
    });

    incomingSocket.on("getPortSuccess", ({ port }) => {
      setPort(port ?? null);
    });

    incomingSocket.on("error", ({ data }) => {
      console.error("Editor socket error:", data);
    });

    set({ editorSocket: incomingSocket });
  },
}));
