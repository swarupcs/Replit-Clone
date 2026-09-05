/** Edits that were typed but never confirmed saved. plan.md §11.7.
 *
 *  The gap this closes: writes are debounced, so there is always a window in
 *  which what is on screen is not on disk. `useUnsavedWorkGuard` warns before
 *  a reload, and a warning is all it does — the browser being closed, the tab
 *  being evicted under memory pressure, a laptop lid, or simply clicking
 *  "leave" ended with the edits gone. And on a dropped connection the queued
 *  write had nowhere to go at all: `pendingWrites` sent it to `emit?.()`,
 *  where the optional call was quietly doing the work of an error handler.
 *
 *  So: from the moment a keystroke is queued, the buffer is written here, and
 *  it is removed only when the SERVER confirms the save. Everything in
 *  between — the debounce, the flight, an offline spell, a crash — is covered
 *  by the same record.
 *
 *  **Nothing here is ever written back to disk on its own.** It is offered to
 *  the person who typed it, and they decide. Silently replaying a local buffer
 *  over a file somebody else has since edited would be a worse failure than
 *  the one this fixes, and it is exactly what "restore my work" tends to mean
 *  if nobody thinks about it.
 */

const KEY_PREFIX = "rc.recovered.";

/** Per file. A buffer larger than this is a generated bundle or a paste of
 *  something enormous, and storing it would spend the whole origin's quota on
 *  one tab nobody is editing by hand. */
const MAX_BYTES_PER_FILE = 256 * 1024;

/** Per project, across all files. localStorage is a few megabytes for the
 *  whole origin and this is not the only thing in it — the workspace session
 *  and the theme live there too, and losing those to a recovery record would
 *  be a poor trade. */
const MAX_BYTES_PER_PROJECT = 1024 * 1024;

export interface RecoveredBuffer {
  relPath: string;
  data: string;
  /** When it was last typed, so the offer can say how old it is. Stale work is
   *  a different decision from work from thirty seconds ago. */
  savedAt: number;
}

function key(projectId: string): string {
  return `${KEY_PREFIX}${projectId}`;
}

/** Reads the record, tolerating anything at all in storage.
 *
 *  Storage is shared with other tabs, survives deploys, and is editable by
 *  hand. A parse failure here used to be the kind of thing that takes a page
 *  down on load, so it returns nothing instead — the cost is one lost recovery
 *  offer, against an IDE that will not open.
 */
function read(projectId: string): RecoveredBuffer[] {
  try {
    const raw = localStorage.getItem(key(projectId));
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (entry): entry is RecoveredBuffer =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as RecoveredBuffer).relPath === "string" &&
        typeof (entry as RecoveredBuffer).data === "string" &&
        typeof (entry as RecoveredBuffer).savedAt === "number",
    );
  } catch {
    return [];
  }
}

function write(projectId: string, buffers: RecoveredBuffer[]): void {
  try {
    if (buffers.length === 0) {
      localStorage.removeItem(key(projectId));
      return;
    }
    localStorage.setItem(key(projectId), JSON.stringify(buffers));
  } catch {
    // A full or disabled storage must not break typing. The buffer is still in
    // memory and still marked unsaved; what is lost is the ability to recover
    // it after a crash, which is strictly better than refusing the keystroke.
  }
}

/** Drops oldest-first until the project fits its budget.
 *
 *  Oldest rather than largest, because the most recently typed file is the one
 *  somebody is actually in the middle of and the one they would miss.
 */
function trim(buffers: RecoveredBuffer[]): RecoveredBuffer[] {
  const newestFirst = [...buffers].sort((a, b) => b.savedAt - a.savedAt);

  const kept: RecoveredBuffer[] = [];
  let total = 0;
  for (const entry of newestFirst) {
    total += entry.data.length;
    if (total > MAX_BYTES_PER_PROJECT) break;
    kept.push(entry);
  }

  return kept;
}

/** Records a buffer as typed-but-unconfirmed. */
export function rememberBuffer(
  projectId: string,
  relPath: string,
  data: string,
): void {
  // Silently skipped rather than truncated: half a file restored as though it
  // were whole is worse than no offer at all.
  if (data.length > MAX_BYTES_PER_FILE) {
    forgetBuffer(projectId, relPath);
    return;
  }

  const others = read(projectId).filter((entry) => entry.relPath !== relPath);
  write(projectId, trim([...others, { relPath, data, savedAt: Date.now() }]));
}

/** Removes one file's record. Called when the SERVER confirms the write, and
 *  when the user discards the offer. */
export function forgetBuffer(projectId: string, relPath: string): void {
  const remaining = read(projectId).filter((entry) => entry.relPath !== relPath);
  write(projectId, remaining);
}

/** What was typed and never confirmed, newest first. */
export function recoveredBuffers(projectId: string): RecoveredBuffer[] {
  return read(projectId).sort((a, b) => b.savedAt - a.savedAt);
}

export function clearRecovered(projectId: string): void {
  write(projectId, []);
}
