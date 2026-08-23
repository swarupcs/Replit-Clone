import type { EditorNamespace } from "../socketHandlers/editorHandler.js";
import { getRunState } from "../containers/runner.js";
import { hasLiveHmr } from "./hmrSockets.js";

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
 *  verifiably landed. Except when a live HMR socket says the dev server will
 *  deliver the update itself: then a reload is the one thing not wanted.
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
        // Re-checked at fire time, not at announce time: the socket may have
        // connected while the debounce ran. With a live HMR socket the dev
        // server pushes the update itself — reloading the iframe would throw
        // away the very component state that socket exists to preserve.
        if (hasLiveHmr(projectId)) return;
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

/** Tells a project's room when its dev server starts or stops answering with
 *  errors.
 *
 *  A dev server that fails to compile answers the preview's page request with
 *  a 5xx — every framework's dev server does this, which makes it a far more
 *  reliable signal than parsing each one's output for "Failed to compile".
 *  The proxy sees that status as it flows past and reports it here, and the
 *  preview pane can say what happened instead of leaving the user to work out
 *  why their save "did nothing".
 */

/** How long to wait for the burst to settle before announcing. One broken
 *  compile usually produces several failing requests (the page, its chunks);
 *  one recovery produces several successes. The state they land in is what is
 *  announced, once. */
const HEALTH_DEBOUNCE_MS = 750;

export interface PreviewHealthAnnouncer {
  /** Records one observed response. Announces only on a settled change. */
  observe: (projectId: string, ok: boolean) => void;
  /** Drops pending announcements and forgets the states. */
  dispose: () => void;
}

export function createPreviewHealthAnnouncer(
  namespace: EditorNamespace,
): PreviewHealthAnnouncer {
  const timers = new Map<string, NodeJS.Timeout>();
  const pending = new Map<string, boolean>();
  const announced = new Map<string, boolean>();

  return {
    observe(projectId: string, ok: boolean): void {
      // Always recorded and the timer always restarts: an observation that
      // matches the last ANNOUNCED state must still cancel an announcement
      // pending for the opposite one — an error followed by a recovery inside
      // the window is nothing at all, not an error that fires late.

      const existing = timers.get(projectId);
      if (existing) clearTimeout(existing);

      pending.set(projectId, ok);
      const timer = setTimeout(() => {
        timers.delete(projectId);
        const settled = pending.get(projectId);
        if (settled === undefined) return;
        pending.delete(projectId);

        // Re-checked at fire time: a recovery that followed a fresh error
        // within the window announces nothing, because the room never heard
        // about the error.
        if ((announced.get(projectId) ?? true) === settled) return;
        announced.set(projectId, settled);

        if (settled) {
          namespace.to(projectId).emit("previewRecovered");
        } else {
          namespace.to(projectId).emit("previewError", { status: 500 });
        }
      }, HEALTH_DEBOUNCE_MS);

      timer.unref?.();
      timers.set(projectId, timer);
    },

    dispose(): void {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      pending.clear();
      announced.clear();
    },
  };
}
