import { create } from "zustand";
import type { Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@replit-clone/shared";
import { useActiveFileTabStore } from "./activeFileTabStore.ts";
import { useTreeStructureStore } from "./treeStructureStore.ts";

export type EditorSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface EditorSocketStore {
  editorSocket: EditorSocket | null;
  lastError: string | null;
  setEditorSocket: (socket: EditorSocket | null) => void;
  clearError: () => void;
}

export const useEditorSocketStore = create<EditorSocketStore>((set) => ({
  editorSocket: null,
  lastError: null,
  clearError: () => set({ lastError: null }),
  setEditorSocket: (incomingSocket) => {
    if (!incomingSocket) {
      set({ editorSocket: null });
      return;
    }

    const setActiveFileTab = useActiveFileTabStore.getState().setActiveFileTab;
    const refreshTree = useTreeStructureStore.getState().refreshTree;

    incomingSocket.on("readFileSuccess", ({ relPath, value }) => {
      setActiveFileTab(relPath, value);
    });

    // Emitted by the server's chokidar watcher, and after any mutation. The
    // watcher previously only logged, so files created by a terminal command
    // never appeared in the tree.
    incomingSocket.on("treeChanged", () => {
      void refreshTree();
    });

    incomingSocket.on("error", ({ message }) => {
      set({ lastError: message });
    });

    set({ editorSocket: incomingSocket, lastError: null });
  },
}));
