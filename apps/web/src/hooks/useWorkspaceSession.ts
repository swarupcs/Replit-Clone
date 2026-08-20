import { useCallback, useEffect, useRef } from "react";
import { useOpenTabsStore } from "../store/openTabsStore.ts";
import { useTreeStructureStore } from "../store/treeStructureStore.ts";
import {
  useWorkspaceStore,
  type WorkspaceSession,
} from "../store/workspaceStore.ts";
import type { EditorSocket } from "../store/editorSocketStore.ts";

/** Remembers and restores a project's arrangement across reloads.
 *
 *  Open tabs, expanded folders and pane sizes all reset on every reload; the
 *  stores held the state but only in memory, so a refresh threw away whatever
 *  arrangement the user had built up.
 *
 *  Tab contents are deliberately NOT persisted — only which files were open.
 *  Restoring them means re-reading from the server, which is what makes sure
 *  the restored buffer matches what is actually on disk rather than a stale
 *  copy from before someone else's edit.
 */
export function useWorkspaceSession(
  projectId: string | undefined,
  socket: EditorSocket | null,
): {
  restored: WorkspaceSession | undefined;
  remember: (patch: Partial<WorkspaceSession>) => void;
} {
  const merge = useWorkspaceStore((state) => state.merge);

  /** Read once per project, before anything writes over it. */
  const restoredRef = useRef<WorkspaceSession | undefined>(undefined);
  const restoredForRef = useRef<string | undefined>(undefined);

  if (projectId && restoredForRef.current !== projectId) {
    restoredForRef.current = projectId;
    restoredRef.current = useWorkspaceStore.getState().get(projectId);
  }

  const remember = useCallback(
    (patch: Partial<WorkspaceSession>) => {
      if (projectId) merge(projectId, patch);
    },
    [projectId, merge],
  );

  // Reopen the files that were open. Needs the socket, since the contents come
  // from the server rather than from storage.
  const reopenedRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const session = restoredRef.current;
    if (!projectId || !socket || !session) return;
    if (reopenedRef.current === projectId) return;

    reopenedRef.current = projectId;

    useTreeStructureStore.getState().setExpandedPaths(session.expandedPaths);

    // The active file last, so it ends up focused after the others have opened.
    const ordered = [
      ...session.openPaths.filter((path) => path !== session.activeRelPath),
      ...(session.activeRelPath ? [session.activeRelPath] : []),
    ];

    for (const relPath of ordered) {
      socket.emit("readFile", { relPath });
    }
  }, [projectId, socket]);

  // Record what is open as it changes. Subscribed rather than polled, and
  // written only when the set actually differs.
  useEffect(() => {
    if (!projectId) return;

    return useOpenTabsStore.subscribe((state) => {
      merge(projectId, {
        openPaths: state.tabs.map((tab) => tab.relPath),
        activeRelPath: state.activeRelPath,
      });
    });
  }, [projectId, merge]);

  useEffect(() => {
    if (!projectId) return;

    return useTreeStructureStore.subscribe((state) => {
      merge(projectId, { expandedPaths: [...state.expandedPaths] });
    });
  }, [projectId, merge]);

  return { restored: restoredRef.current, remember };
}
