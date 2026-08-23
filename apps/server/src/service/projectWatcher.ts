import chokidar from "chokidar";
import type { FSWatcher } from "chokidar";
import path from "node:path";
import { IGNORED_DIRECTORIES } from "./fileTreeService.js";
import { projectRoot } from "../utils/projectPaths.js";

/** Watches a project's files, once per project rather than once per socket.
 *
 *  The watcher used to be created inside the connection handler, so two tabs on
 *  one project meant two recursive watchers over the same tree — twice the
 *  inotify handles, and two `treeChanged` broadcasts per change, each of which
 *  made every client refetch the whole tree.
 *
 *  It also only ignored `node_modules`, so `.git` bookkeeping, build output and
 *  `__pycache__` all produced broadcasts for files the editor never shows.
 */

/** Collapses a burst of filesystem events into one broadcast. Writing a file
 *  can easily produce several, and a build produces hundreds. */
const DEBOUNCE_MS = 200;

interface Watch {
  watcher: FSWatcher;
  sockets: number;
  timer?: NodeJS.Timeout;
  /** Files seen since the last callback, project-relative and POSIX, so a
   *  burst reports WHICH files changed and not only that something did. */
  pending: Set<string>;
}

const watches = new Map<string, Watch>();

/** Starts watching a project if nobody is yet, and returns a release function.
 *
 *  `onChange` is called at most once per debounce window, for whichever
 *  subscribers exist at that moment, with the project-relative POSIX paths of
 *  everything the window saw.
 *
 *  Releasing reports whether that was the LAST subscriber, so a caller holding
 *  state that belongs to the watch — rather than to the socket — knows when to
 *  drop it. Two tabs on one project release twice, and only the second one
 *  means the project is no longer being watched.
 */
export function retainProjectWatcher(
  projectId: string,
  onChange: (changedFiles: string[]) => void,
): () => boolean {
  const existing = watches.get(projectId);

  if (existing) {
    existing.sockets += 1;
  } else {
    const root = projectRoot(projectId);
    const watcher = chokidar.watch(root, {
      // Matches what the file tree itself hides, so a change to something the
      // editor never shows does not make every client refetch.
      ignored: (target: string) =>
        IGNORED_DIRECTORIES.some(
          (name) => target.includes(`/${name}/`) || target.endsWith(`/${name}`),
        ),
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 500 },
      ignoreInitial: true,
    });

    const watch: Watch = { watcher, sockets: 1, pending: new Set() };

    watcher.on("all", (_event, target) => {
      // The container is Linux; a Windows watcher reports backslashes.
      const relative = path.relative(root, target).split(path.sep).join("/");
      if (relative && !relative.startsWith("../")) watch.pending.add(relative);

      if (watch.timer) clearTimeout(watch.timer);
      watch.timer = setTimeout(() => {
        watch.timer = undefined;
        const changedFiles = [...watch.pending];
        watch.pending.clear();
        onChange(changedFiles);
      }, DEBOUNCE_MS);
    });

    watches.set(projectId, watch);
  }

  let released = false;

  return () => {
    // Idempotent, and a second call is not a close: reporting one would have a
    // caller drop the watch's state while another tab is still watching.
    if (released) return false;
    released = true;

    const watch = watches.get(projectId);
    if (!watch) return false;

    watch.sockets -= 1;
    if (watch.sockets > 0) return false;

    if (watch.timer) clearTimeout(watch.timer);
    void watch.watcher.close();
    watches.delete(projectId);
    return true;
  };
}
