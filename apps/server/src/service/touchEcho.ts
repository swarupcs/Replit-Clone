/** Telling our own writes apart from the user's, on the way back.
 *
 *  `touchFilesInContainer` exists because Docker Desktop carries the CONTENTS
 *  of a host write into the container but not the inotify event, so watchers
 *  inside the container never hear about a save. Running `touch` in there is a
 *  real write from the container's side of the mount, which does emit inotify.
 *
 *  What that missed is that the mount is a two-way street for events even
 *  though it is not one for inotify: the touch lands on the host file too, and
 *  the server's own chokidar watcher reports it as a change. Answering that
 *  report the same way — broadcast, reload the preview, touch the files — is a
 *  loop with no exit. Measured on Windows it ran at roughly one cycle a
 *  second: the file tree refetched forever, git status with it, and the
 *  preview iframe remounted every cycle, so the dev server recompiled the page
 *  continuously and no edit could ever be read on screen.
 *
 *  So each touch says in advance which files it is about to disturb, and the
 *  first event for each of those is spent recognising the echo rather than
 *  acted on.
 *
 *  This is a window, not a proof — the two writes are identical on disk, and
 *  nothing about a file says who touched it. A genuine save to the same file
 *  inside the window is therefore swallowed. The window is kept short for that
 *  reason, and the trade is worth making in only one direction: at worst one
 *  save reaches the preview late, against a loop that made every save
 *  unreadable.
 */

/** Long enough for the mount to carry the touch back — measured at one to
 *  three seconds on Docker Desktop for Windows, including the watcher's own
 *  write-settling delay — and short enough that a save mistaken for an echo is
 *  a save delayed rather than a save lost. */
const ECHO_TTL_MS = 5000;

interface Expectation {
  /** Echoes still owed. Counted rather than flagged: two touches of one file
   *  before either comes back owe two events, and consuming a single one would
   *  leave the second to restart exactly the loop this prevents. */
  outstanding: number;
  expiresAt: number;
}

const expected = new Map<string, Map<string, Expectation>>();

/** Records that these paths are about to be touched by us. Must be called
 *  BEFORE the write, or its echo can arrive first and be believed. */
export function expectTouchEcho(
  projectId: string,
  relPaths: readonly string[],
  now = Date.now(),
): void {
  if (relPaths.length === 0) return;

  let forProject = expected.get(projectId);
  if (!forProject) {
    forProject = new Map<string, Expectation>();
    expected.set(projectId, forProject);
  }

  const expiresAt = now + ECHO_TTL_MS;

  for (const relPath of relPaths) {
    const current = forProject.get(relPath);
    // An expired expectation is replaced rather than added to: whatever it was
    // owed never came, and carrying the debt forward would swallow real saves.
    const outstanding =
      current && current.expiresAt > now ? current.outstanding + 1 : 1;
    forProject.set(relPath, { outstanding, expiresAt });
  }
}

/** The changes in a watcher burst that we did not cause ourselves.
 *
 *  Consuming happens for every recognised path, not only until the caller has
 *  what it needs, so a burst that mixes a real save with echoes settles the
 *  echoes as well as reporting the save.
 */
export function withoutOurOwnTouches(
  projectId: string,
  changedFiles: readonly string[],
  now = Date.now(),
): string[] {
  const forProject = expected.get(projectId);
  if (!forProject) return [...changedFiles];

  const theirs: string[] = [];

  for (const relPath of changedFiles) {
    const expectation = forProject.get(relPath);

    if (!expectation || expectation.expiresAt <= now) {
      // Stale entries are dropped as they are met rather than swept on a
      // timer: nothing here is worth a periodic wake-up, and a project that is
      // never touched again is forgotten with its socket.
      if (expectation) forProject.delete(relPath);
      theirs.push(relPath);
      continue;
    }

    if (expectation.outstanding <= 1) forProject.delete(relPath);
    else forProject.set(relPath, { ...expectation, outstanding: expectation.outstanding - 1 });
  }

  if (forProject.size === 0) expected.delete(projectId);

  return theirs;
}

/** Forgets a project's outstanding echoes — its watcher has gone. */
export function forgetTouchEchoes(projectId: string): void {
  expected.delete(projectId);
}

/** Test-only: the module is one process-wide map. */
export function resetTouchEchoes(): void {
  expected.clear();
}
