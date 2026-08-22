import type { EditorNamespace } from "../socketHandlers/editorHandler.js";
import { getRunState } from "../containers/runner.js";

/** Announces "the preview's inputs changed" to a project's room.
 *
 *  The server is the one place that reliably sees every write to a project —
 *  through the editor's saves, the collab flush, uploads, replaces, and
 *  terminal commands alike, via its own host-side watcher. Dev servers
 *  usually notice writes themselves and hot-reload, but on a bind mount that
 *  swallows inotify (Docker Desktop on Windows and macOS) the watcher inside
 *  the container is never told, and the preview shows the previous render
 *  however long the user waits. So the server says it instead, and the client
 *  reloads — a request is compiled from disk, which is where the save
 *  verifiably landed.
 */

/** How long to wait after the last change before reloading. Writing one file
 *  can produce several watcher events, and the tree broadcast and this are
 *  deliberately separate: a reload is heavier than a tree refetch, and a save
 *  plus the writes that trail it should be ONE reload. */
const RELOAD_DEBOUNCE_MS = 500;

export interface PreviewAnnouncer {
  /** Schedules one announcement for the project, if its run is live. */
  announce: (projectId: string) => void;
  /** Drops any pending announcements. */
  dispose: () => void;
}

export function createPreviewAnnouncer(
  namespace: EditorNamespace,
): PreviewAnnouncer {
  const timers = new Map<string, NodeJS.Timeout>();

  return {
    announce(projectId: string): void {
      // Only while the dev server is live: with nothing listening, a reload
      // would re-fetch the "not running" placeholder and tell the user
      // nothing they do not already know. `previewReady` covers the moment a
      // run comes up.
      if (getRunState(projectId).status !== "running") return;

      const existing = timers.get(projectId);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        timers.delete(projectId);
        namespace.to(projectId).emit("previewChanged");
      }, RELOAD_DEBOUNCE_MS);

      // A pending timer must never hold the process open during a shutdown
      // that is otherwise ready to go.
      timer.unref?.();
      timers.set(projectId, timer);
    },

    dispose(): void {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
