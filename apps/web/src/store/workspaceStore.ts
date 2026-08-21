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

/** The fields the restore path iterates, and therefore the ones a stored
 *  session may never be missing. */
const REQUIRED: Pick<
  WorkspaceSession,
  "openPaths" | "activeRelPath" | "expandedPaths"
> = {
  openPaths: [],
  activeRelPath: null,
  expandedPaths: [],
};

/** Repairs a stored session on the way out.
 *
 *  `merge` used to take a Partial and cast the result to a full session, so
 *  whichever field was written FIRST decided the shape: toggling a panel or
 *  dragging a divider before opening a file stored a session with no
 *  `openPaths` and no `expandedPaths`. The next load handed one of those
 *  undefined to `setExpandedPaths`, which reads `.length` — and because the
 *  restore runs in an effect in ProjectPlayground, above every panel-level
 *  error boundary, the throw took the entire page down with "Something broke"
 *  rather than degrading one pane.
 *
 *  `merge` seeds the required fields now, but sessions written by the older
 *  build are already sitting in people's localStorage, so reading has to cope
 *  with them too — otherwise the fix helps nobody who already hit the bug.
 *  Arrays are checked rather than assumed for the same reason: this data has
 *  been through JSON and an older schema, and it is not ours to trust.
 */
function repair(session: WorkspaceSession | undefined): WorkspaceSession | undefined {
  if (!session) return undefined;

  return {
    ...session,
    openPaths: Array.isArray(session.openPaths) ? session.openPaths : [],
    expandedPaths: Array.isArray(session.expandedPaths) ? session.expandedPaths : [],
    activeRelPath: typeof session.activeRelPath === "string" ? session.activeRelPath : null,
  };
}

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

      get: (projectId) => repair(getState().sessions[projectId]),

      merge: (projectId, patch) =>
        setState((state) => {
          const next = {
            ...state.sessions,
            // REQUIRED first, so a patch carrying only a pane size still
            // produces a session the restore can iterate. This used to be a
            // cast, which asserted that shape instead of establishing it.
            [projectId]: {
              ...REQUIRED,
              ...state.sessions[projectId],
              ...patch,
            },
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
