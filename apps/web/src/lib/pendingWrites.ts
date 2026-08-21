/** Debounced file writes, keyed by path.
 *
 *  Module-level rather than per-component, because the editor can now show two
 *  panes and the same file may be open in both. Two independent queues for one
 *  path would race each other; one queue for the whole editor cannot.
 *
 *  The rule this exists to enforce: a file's pending write may only ever be
 *  cancelled by another write to THAT file. An earlier version kept one timer
 *  for the whole editor and cleared it on every keystroke, so typing in a
 *  second file discarded the first file's unsaved edits with no warning.
 */

export type WriteEmitter = (relPath: string, data: string) => void;

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  data: string;
}

const pending = new Map<string, Pending>();

/** Where writes go. Set by the editor when a socket is available; without one
 *  a queued write is dropped rather than thrown, since there is nowhere to
 *  send it and the tab stays marked unsaved either way. */
let emit: WriteEmitter | null = null;

export function setWriteEmitter(emitter: WriteEmitter | null): void {
  emit = emitter;
}

/** Schedules a write, replacing only this path's own pending one. */
export function queueWrite(relPath: string, data: string, delayMs: number): void {
  const existing = pending.get(relPath);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    pending.delete(relPath);
    emit?.(relPath, data);
  }, delayMs);

  pending.set(relPath, { timer, data });
}

/** Sends one path's pending write immediately, if it has one. */
export function flushWrite(relPath: string): void {
  const queued = pending.get(relPath);
  if (!queued) return;

  clearTimeout(queued.timer);
  pending.delete(relPath);
  emit?.(relPath, queued.data);
}

/** Sends every pending write. Used when the active file changes and when the
 *  editor is torn down. */
export function flushAllWrites(): void {
  for (const relPath of [...pending.keys()]) flushWrite(relPath);
}

/** Drops a path's pending write without sending it — for a file that has been
 *  deleted, where writing it back would recreate it. */
export function discardWrite(relPath: string): void {
  const queued = pending.get(relPath);
  if (!queued) return;

  clearTimeout(queued.timer);
  pending.delete(relPath);
}

/** Moves a pending write to a path's new name.
 *
 *  A file can be renamed while a write for it is still on the clock. Left
 *  alone, that write lands under the OLD name and recreates the file the
 *  rename just moved. Dropping it instead would throw away whatever was typed
 *  in the last second, so it is re-keyed rather than discarded.
 */
export function renameWrite(from: string, to: string): void {
  const queued = pending.get(from);
  if (!queued) return;

  clearTimeout(queued.timer);
  pending.delete(from);

  // Re-queued with no delay left to serve: the debounce existed to batch
  // keystrokes, and the rename has already interrupted that.
  queueWrite(to, queued.data, 0);
}

/** Paths with a write still in flight. */
export function pendingPaths(): string[] {
  return [...pending.keys()];
}

/** Only for tests, which need a clean slate between cases. */
export function resetPendingWrites(): void {
  for (const queued of pending.values()) clearTimeout(queued.timer);
  pending.clear();
  emit = null;
}
