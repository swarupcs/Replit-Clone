import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** Layout and open files, per project, across reloads.
 *
 *  Everything reset on every reload: which files were open, which folders were
 *  expanded, how the panes were sized. The stores already held all of it — it
 *  simply lived only in memory, so a refresh threw away the arrangement the
 *  user had built up.
 */
export interface WorkspaceSession {
  openPaths: string[];
  activeRelPath: string | null;
  expandedPaths: string[];
  /** Pane sizes in pixels, keyed by which split they belong to. */
  sidebarWidth?: number;
  panelHeight?: number;
  previewWidth?: number;
  /** Width of the first editor pane when the editor is split. */
  editorSplitWidth?: number;
  showSidebar?: boolean;
  showPanel?: boolean;
  showPreview?: boolean;
}

interface WorkspaceStore {
  /** Keyed by project id, so switching projects does not inherit the other's
   *  arrangement. */
  sessions: Record<string, WorkspaceSession>;
  get: (projectId: string) => WorkspaceSession | undefined;
  merge: (projectId: string, patch: Partial<WorkspaceSession>) => void;
  forget: (projectId: string) => void;
}

/** Cap on remembered projects, so this cannot grow without bound in a browser
 *  that never clears its storage. Oldest keys go first. */
const MAX_SESSIONS = 25;

function prune(sessions: Record<string, WorkspaceSession>) {
  const keys = Object.keys(sessions);
  if (keys.length <= MAX_SESSIONS) return sessions;

  const trimmed = { ...sessions };
  for (const key of keys.slice(0, keys.length - MAX_SESSIONS)) {
    delete trimmed[key];
  }
  return trimmed;
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (setState, getState) => ({
      sessions: {},

      get: (projectId) => getState().sessions[projectId],

      merge: (projectId, patch) =>
        setState((state) => {
          const next = {
            ...state.sessions,
            [projectId]: { ...state.sessions[projectId], ...patch } as WorkspaceSession,
          };
          return { sessions: prune(next) };
        }),

      forget: (projectId) =>
        setState((state) => {
          const next = { ...state.sessions };
          delete next[projectId];
          return { sessions: next };
        }),
    }),
    {
      name: "rc-workspace",
      // Resolved when the store is created rather than when the module
      // loads, so a host that defines localStorage later still gets it.
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ sessions: state.sessions }),
    },
  ),
);
