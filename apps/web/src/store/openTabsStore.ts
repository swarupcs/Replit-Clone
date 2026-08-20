import { create } from "zustand";
import { fileExtension } from "@replit-clone/shared";

export interface OpenTab {
  /** POSIX path relative to the project root; unique per tab. */
  relPath: string;
  name: string;
  extension: string | undefined;
  /** Latest known contents. Monaco holds its own model per tab, so this is
   *  only the value the editor is seeded with. */
  value: string;
  /** True when the debounced write has not landed yet. */
  isDirty: boolean;
}

interface OpenTabsStore {
  tabs: OpenTab[];
  activeRelPath: string | null;
  /** Where to put the cursor once a file finishes opening.
   *
   *  Opening is asynchronous — the contents arrive over the socket — so a
   *  search result cannot jump to its line at click time. It leaves the
   *  position here and the editor consumes it on arrival. */
  pendingReveal: { relPath: string; line: number; column: number } | null;
  openTab: (relPath: string, value: string) => void;
  closeTab: (relPath: string) => void;
  setActive: (relPath: string) => void;
  markDirty: (relPath: string, isDirty: boolean) => void;
  /** Applies an external change (rename or delete) coming from the tree. */
  renameTab: (relPath: string, newRelPath: string) => void;
  closeAll: () => void;
  requestReveal: (relPath: string, line: number, column: number) => void;
  consumeReveal: () => { relPath: string; line: number; column: number } | null;
}

function baseName(relPath: string): string {
  return relPath.split("/").pop() ?? relPath;
}

export const useOpenTabsStore = create<OpenTabsStore>((set, get) => ({
  tabs: [],
  activeRelPath: null,
  pendingReveal: null,

  openTab: (relPath, value) => {
    const existing = get().tabs.find((tab) => tab.relPath === relPath);

    if (existing) {
      // Re-opening a file refreshes its contents but keeps its tab position.
      set((state) => ({
        activeRelPath: relPath,
        tabs: state.tabs.map((tab) =>
          tab.relPath === relPath ? { ...tab, value, isDirty: false } : tab,
        ),
      }));
      return;
    }

    const name = baseName(relPath);
    set((state) => ({
      activeRelPath: relPath,
      tabs: [
        ...state.tabs,
        { relPath, name, extension: fileExtension(name), value, isDirty: false },
      ],
    }));
  },

  closeTab: (relPath) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.relPath === relPath);
      const tabs = state.tabs.filter((tab) => tab.relPath !== relPath);

      if (state.activeRelPath !== relPath) return { tabs };

      // Focus the neighbour on the left, matching every editor's behaviour.
      const next = tabs[Math.max(0, index - 1)];
      return { tabs, activeRelPath: next?.relPath ?? null };
    }),

  setActive: (relPath) => set({ activeRelPath: relPath }),

  markDirty: (relPath, isDirty) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.relPath === relPath ? { ...tab, isDirty } : tab,
      ),
    })),

  renameTab: (relPath, newRelPath) =>
    set((state) => {
      const name = baseName(newRelPath);
      return {
        tabs: state.tabs.map((tab) =>
          tab.relPath === relPath
            ? { ...tab, relPath: newRelPath, name, extension: fileExtension(name) }
            : tab,
        ),
        activeRelPath:
          state.activeRelPath === relPath ? newRelPath : state.activeRelPath,
      };
    }),

  closeAll: () => set({ tabs: [], activeRelPath: null, pendingReveal: null }),

  requestReveal: (relPath, line, column) =>
    set({ pendingReveal: { relPath, line, column } }),

  consumeReveal: () => {
    const pending = get().pendingReveal;
    if (pending) set({ pendingReveal: null });
    return pending;
  },
}));

/** The currently focused tab, or null. */
export const selectActiveTab = (state: OpenTabsStore): OpenTab | null =>
  state.tabs.find((tab) => tab.relPath === state.activeRelPath) ?? null;

/** True while any open file has edits that have not reached the server. */
export const selectHasUnsavedWork = (state: OpenTabsStore): boolean =>
  state.tabs.some((tab) => tab.isDirty);
