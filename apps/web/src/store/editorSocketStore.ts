import { create } from "zustand";
import type { Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@replit-clone/shared";
import { useOpenTabsStore } from "./openTabsStore.ts";
import { useTreeStructureStore } from "./treeStructureStore.ts";
import { discardWrite, renameWrite } from "../lib/pendingWrites.ts";

export type EditorSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface EditorSocketStore {
  editorSocket: EditorSocket | null;
  lastError: string | null;
  /** What this connection may do. Unknown until the server says, which is why
   *  it starts null rather than assuming either answer. */
  accessLevel: "viewer" | "editor" | "owner" | null;
  /** Files that changed on disk while open — a terminal command, a build step.
   *  Reported rather than merged, so nobody's in-progress work vanishes. */
  externallyChanged: string[];
  setEditorSocket: (socket: EditorSocket | null) => void;
  clearError: () => void;
}

export const useEditorSocketStore = create<EditorSocketStore>((set) => ({
  editorSocket: null,
  lastError: null,
  accessLevel: null,
  externallyChanged: [],
  clearError: () => set({ lastError: null, externallyChanged: [] }),

  setEditorSocket: (incomingSocket) => {
    if (!incomingSocket) {
      set({ editorSocket: null, accessLevel: null });
      return;
    }

    const tabs = useOpenTabsStore.getState();
    const refreshTree = useTreeStructureStore.getState().refreshTree;

    incomingSocket.on("readFileSuccess", ({ relPath, value }) => {
      tabs.openTab(relPath, value);
    });

    incomingSocket.on("writeFileSuccess", ({ relPath }) => {
      useOpenTabsStore.getState().markDirty(relPath, false);
    });

    // The same thing for a file being edited together, where the SERVER does
    // the writing. Without it nothing ever cleared the marker on a shared
    // file — and since every file an editor opens is shared, that meant every
    // tab, permanently.
    incomingSocket.on("docSaved", ({ relPath }) => {
      useOpenTabsStore.getState().markDirty(relPath, false);
    });

    incomingSocket.on("renameEntrySuccess", ({ relPath, newRelPath }) => {
      // The queued write moves with the tab. Left on the old key it would land
      // under a name the file no longer has, recreating it there.
      renameWrite(relPath, newRelPath);
      useOpenTabsStore.getState().renameTab(relPath, newRelPath);
    });

    // A move is a rename with a different parent as far as an open tab is
    // concerned; leaving it on the old path would make the next save recreate
    // the file where it used to be.
    incomingSocket.on("moveEntrySuccess", ({ relPath, newRelPath }) => {
      renameWrite(relPath, newRelPath);
      useOpenTabsStore.getState().renameTab(relPath, newRelPath);
    });

    incomingSocket.on("deleteFileSuccess", ({ relPath }) => {
      // Dropped rather than flushed: a queued write for a file that has just
      // been deleted would recreate it moments later.
      discardWrite(relPath);
      useOpenTabsStore.getState().closeTab(relPath);
    });

    // A folder takes every file under it. Without this those tabs stayed open
    // over files that no longer exist, and their queued writes put them back —
    // the same defect as a single delete, one level up.
    incomingSocket.on("deleteFolderSuccess", ({ relPath }) => {
      const prefix = `${relPath}/`;
      const tabs = useOpenTabsStore.getState().tabs;

      for (const tab of tabs) {
        if (!tab.relPath.startsWith(prefix)) continue;

        discardWrite(tab.relPath);
        useOpenTabsStore.getState().closeTab(tab.relPath);
      }
    });

    // Emitted by the server's chokidar watcher and after any mutation. The
    // watcher previously only logged, so files created by a terminal command
    // never appeared in the tree.
    incomingSocket.on("treeChanged", () => {
      void refreshTree();
    });

    incomingSocket.on("projectAccess", ({ level }) => {
      set({ accessLevel: level });
    });

    incomingSocket.on("docExternalChange", ({ relPath }) => {
      set((state) =>
        state.externallyChanged.includes(relPath)
          ? state
          : { externallyChanged: [...state.externallyChanged, relPath] },
      );
    });

    incomingSocket.on("error", ({ message }) => {
      set({ lastError: message });
    });

    set({
      editorSocket: incomingSocket,
      lastError: null,
      accessLevel: null,
      externallyChanged: [],
    });
  },
}));

/** True once the server has confirmed this connection may change the project.
 *  Null — not yet known — counts as read-only, so nothing is offered before
 *  it is certain to work. */
export const selectCanEdit = (state: EditorSocketStore): boolean =>
  state.accessLevel === "editor" || state.accessLevel === "owner";
