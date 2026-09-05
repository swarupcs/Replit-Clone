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
 *
 *  **Since §11.7 there is a second rule, and it is the same rule one level
 *  out: a write is never dropped for want of somewhere to send it.** Every
 *  flush used to end at `emit?.(relPath, data)`, where the optional call was
 *  quietly doing the work of an error handler.
 *
 *  Be precise about what that did and did not lose, because it is less than it
 *  looks and the difference is the reason this is two mechanisms rather than
 *  one. **socket.io already buffers**: an `emit` on a live-but-disconnected
 *  socket goes into its `sendBuffer` and is flushed on reconnect, so a brief
 *  drop with the editor still mounted was always survivable. What was NOT
 *  survivable is everything outside one socket's lifetime — the emitter being
 *  uninstalled on unmount, the socket being torn down and rebuilt by
 *  navigating away and back, reconnection attempts being exhausted, and any
 *  reload, crash or closed lid at all, since that buffer lives in memory.
 *
 *  So: `unsent` covers the gap between emitters, and `recoveredWork` covers
 *  the gap between page loads. Neither replaces socket.io's buffer; they sit
 *  on either side of it.
 */

import { forgetBuffer, rememberBuffer } from "./recoveredWork.ts";
import { useConnectionStore } from "../store/connectionStore.ts";

export type WriteEmitter = (relPath: string, data: string) => void;

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  data: string;
}

const pending = new Map<string, Pending>();

/** Writes whose debounce elapsed while there was nowhere to send them.
 *
 *  Separate from `pending` because they are past their timer and must go the
 *  instant a connection exists, rather than waiting for another keystroke to
 *  re-queue them. Keyed by path, so a file edited repeatedly while offline
 *  sends its latest state once rather than its history in order.
 */
const unsent = new Map<string, string>();

/** Which project these writes belong to, for the recovery record.
 *
 *  Explicit rather than inferred: this module is a singleton and the editor
 *  can move between projects without it being torn down, and a buffer filed
 *  under the wrong project would be offered back in the wrong workspace.
 */
let scope: string | null = null;

export function setWriteScope(projectId: string | null): void {
  scope = projectId;
}

/** Keeps the count somewhere the interface can see it. "Unsaved" and "unsaved
 *  and unsendable" are different states and only one is somebody's problem. */
function publishQueueDepth(): void {
  useConnectionStore.getState().setQueuedWrites(pending.size + unsent.size);
}

/** Where writes go. Set by the editor when a socket is available; without one
 *  a queued write is dropped rather than thrown, since there is nowhere to
 *  send it and the tab stays marked unsaved either way. */
let emit: WriteEmitter | null = null;

export function setWriteEmitter(emitter: WriteEmitter | null): void {
  emit = emitter;
  if (emitter) drainUnsent();
}

/** Sends everything that was waiting for a connection.
 *
 *  Drained through a copy, and cleared first: an emitter that throws — a
 *  socket that reports itself connected and is not — must not leave half the
 *  map sent and the other half in a state nobody can reason about. Anything
 *  that fails goes straight back in.
 */
function drainUnsent(): void {
  if (unsent.size === 0) return;

  const queued = [...unsent.entries()];
  unsent.clear();

  for (const [relPath, data] of queued) {
    try {
      emit?.(relPath, data);
    } catch {
      unsent.set(relPath, data);
    }
  }

  publishQueueDepth();
}

/** Schedules a write, replacing only this path's own pending one. */
export function queueWrite(relPath: string, data: string, delayMs: number): void {
  const existing = pending.get(relPath);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    pending.delete(relPath);
    send(relPath, data);
  }, delayMs);

  pending.set(relPath, { timer, data });

  // Recorded on the way IN, not on the way out, so the window this whole file
  // exists to cover — the debounce itself — is covered too.
  if (scope) rememberBuffer(scope, relPath, data);
  publishQueueDepth();
}

/** Sends a write, or keeps it until there is somewhere to send it. */
function send(relPath: string, data: string): void {
  if (!emit) {
    unsent.set(relPath, data);
    publishQueueDepth();
    return;
  }

  try {
    emit(relPath, data);
  } catch {
    unsent.set(relPath, data);
  }
  publishQueueDepth();
}

/** Called when the server confirms a write. The recovery record is cleared
 *  HERE and nowhere else: until the server has said so, the only proof the
 *  edit survived is the copy in storage. */
export function confirmWrite(relPath: string): void {
  if (scope) forgetBuffer(scope, relPath);
}

/** Sends one path's pending write immediately, if it has one. */
export function flushWrite(relPath: string): void {
  const queued = pending.get(relPath);
  if (!queued) return;

  clearTimeout(queued.timer);
  pending.delete(relPath);
  send(relPath, queued.data);
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
  if (queued) {
    clearTimeout(queued.timer);
    pending.delete(relPath);
  }

  // Also from the unsent map and the recovery record, or a deleted file would
  // be recreated by a write that outlived it — the exact failure this function
  // exists to prevent, one layer further down than it used to reach.
  unsent.delete(relPath);
  if (scope) forgetBuffer(scope, relPath);
  publishQueueDepth();
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
  const stranded = unsent.get(from);
  const data = queued?.data ?? stranded;
  if (data === undefined) return;

  if (queued) {
    clearTimeout(queued.timer);
    pending.delete(from);
  }
  unsent.delete(from);
  if (scope) forgetBuffer(scope, from);

  // Re-queued with no delay left to serve: the debounce existed to batch
  // keystrokes, and the rename has already interrupted that.
  queueWrite(to, data, 0);
}

/** Paths with a write still in flight, waiting for a timer or a connection. */
export function pendingPaths(): string[] {
  return [...new Set([...pending.keys(), ...unsent.keys()])];
}

/** Paths whose write is past its timer with nowhere to go. */
export function unsentPaths(): string[] {
  return [...unsent.keys()];
}

/** Only for tests, which need a clean slate between cases. */
export function resetPendingWrites(): void {
  for (const queued of pending.values()) clearTimeout(queued.timer);
  pending.clear();
  unsent.clear();
  emit = null;
  scope = null;
}
