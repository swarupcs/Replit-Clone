import { useCallback, useEffect, useRef } from "react";
import { useOpenTabsStore } from "../store/openTabsStore.ts";
import { useTreeStructureStore } from "../store/treeStructureStore.ts";
import {
  useWorkspaceStore,
  type WorkspaceSession,
} from "../store/workspaceStore.ts";
import { whenSessionSettled } from "../lib/sessionSync.ts";
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
/** Reopens what was open.
 *
 *  Restoring an arrangement is a convenience; opening the project is not. This
 *  is called from an effect belonging to ProjectPlayground, which sits ABOVE
 *  every panel-level error boundary, so anything thrown here used to take the
 *  whole page down to "Something broke" -- one unreadable value in localStorage
 *  and the IDE would not open at all. Failing quietly costs the user their tab
 *  layout and nothing else.
 */
function restore(session: WorkspaceSession, socket: EditorSocket): void {
  try {
    useTreeStructureStore.getState().setExpandedPaths(session.expandedPaths);

    // The active file last, so it ends up focused after the others.
    const ordered = [
      ...session.openPaths.filter((path) => path !== session.activeRelPath),
      ...(session.activeRelPath ? [session.activeRelPath] : []),
    ];

    for (const relPath of ordered) {
      socket.emit("readFile", { relPath });
    }
  } catch (error) {
    console.warn("could not restore the workspace session", error);
  }
}

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
    if (!projectId || !socket) return;
    if (reopenedRef.current === projectId) return;

    reopenedRef.current = projectId;
    let cancelled = false;

    void (async () => {
      // The account's session may still be in flight -- plan.md §13.11. On a
      // machine that has never opened this project there is nothing in
      // localStorage to restore, so without this whether the second machine
      // comes back to your tabs depends on which of two round trips wins.
      // Bounded, and a no-op when nothing is syncing: an offline browser has
      // to open the project on time regardless.
      await whenSessionSettled();
      if (cancelled) return;

      // Re-read rather than reuse the value captured at first render, for the
      // same reason: on that machine the render happened before there was
      // anything to read. A session that WAS there at render is unchanged by
      // this, because a pull never overwrites a key changed on this machine.
      const session = restoredRef.current ?? useWorkspaceStore.getState().get(projectId);
      if (!session) return;

      restore(session, socket);
    })();

    return () => {
      cancelled = true;
    };
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

    // The subscription fires on every change to the tree store, most of which
    // are refetches that leave the open folders exactly as they were. Writing
    // regardless meant a new array into the session store -- and a localStorage
    // write -- on every tree refresh, for a value that had not moved.
    let previous = useTreeStructureStore.getState().expandedPaths;

    return useTreeStructureStore.subscribe((state) => {
      if (state.expandedPaths === previous) return;
      previous = state.expandedPaths;
      merge(projectId, { expandedPaths: [...state.expandedPaths] });
    });
  }, [projectId, merge]);

  return { restored: restoredRef.current, remember };
}
