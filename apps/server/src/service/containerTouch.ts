import { execCapture } from "../containers/execCapture.js";
import { getRunningContainer } from "../containers/containerManager.js";
import { watchPolling } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { expectTouchEcho } from "./touchEcho.js";

/** Notifies watchers INSIDE a container that files on the host changed.
 *
 *  The editor's saves reach the container's filesystem — that is what the bind
 *  mount is for — but on Docker Desktop (Windows and macOS) no inotify event
 *  crosses the VM boundary with them. The dev server started by Run is told
 *  to poll, so it notices anyway; a tool the user started in the terminal is
 *  not so lucky unless it happens to read the polling env vars itself.
 *  `touch` run inside the container is a real write from the container's side
 *  of the mount, so the kernel does emit inotify for it — one save, one event,
 *  and every watcher technology wakes up.
 *
 *  `-c` because the window's events include deletions: a plain touch would
 *  resurrect a file the user just asked to remove.
 */

/** Enough for any hand edit or codegen worth reloading; stops a build that
 *  rewrote the world from turning into one unbounded exec. */
const MAX_FILES_PER_EXEC = 200;

export async function touchFilesInContainer(
  projectId: string,
  changedFiles: string[],
): Promise<void> {
  // Where the mount carries inotify, the container's watchers were told at
  // the moment of the save and this would be a wasted exec per change.
  if (!watchPolling || changedFiles.length === 0) return;

  const container = await getRunningContainer(projectId).catch(() => undefined);
  if (!container) return;

  // The paths come from the server's own watcher, already project-relative
  // and POSIX — but this feeds a container exec, so the filter is cheap
  // insurance rather than trust.
  const unique = [...new Set(changedFiles)].filter(
    (file) =>
      file !== "" &&
      !file.startsWith("/") &&
      !file.split("/").includes(".."),
  );

  if (unique.length === 0) return;

  const touching = unique.slice(0, MAX_FILES_PER_EXEC);

  // Said BEFORE the write, because the mount carries it back to the host and
  // the server's own watcher reports it as a change. Answering that report by
  // touching again is a loop with no exit — see touchEcho.ts.
  expectTouchEcho(projectId, touching);

  try {
    await execCapture(container, ["touch", "-c", ...touching]);
  } catch (error) {
    // A notification, best effort: the preview reload covers the dev server
    // on its own, so a failed touch must not surface as an error anywhere.
    logger.debug("container touch failed", {
      projectId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
