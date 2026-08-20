import chokidar from "chokidar";
import type { FSWatcher } from "chokidar";
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
}

const watches = new Map<string, Watch>();

/** Starts watching a project if nobody is yet, and returns a release function.
 *
 *  `onChange` is called at most once per debounce window, for whichever
 *  subscribers exist at that moment.
 */
export function retainProjectWatcher(
  projectId: string,
  onChange: () => void,
): () => void {
  const existing = watches.get(projectId);

  if (existing) {
    existing.sockets += 1;
  } else {
    const watcher = chokidar.watch(projectRoot(projectId), {
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

    const watch: Watch = { watcher, sockets: 1 };

    watcher.on("all", () => {
      if (watch.timer) clearTimeout(watch.timer);
      watch.timer = setTimeout(() => {
        watch.timer = undefined;
        onChange();
      }, DEBOUNCE_MS);
    });

    watches.set(projectId, watch);
  }

  let released = false;

  return () => {
    if (released) return;
    released = true;

    const watch = watches.get(projectId);
    if (!watch) return;

    watch.sockets -= 1;
    if (watch.sockets > 0) return;

    if (watch.timer) clearTimeout(watch.timer);
    void watch.watcher.close();
    watches.delete(projectId);
  };
}
