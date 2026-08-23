/** Tracks which projects have a live HMR websocket through the preview proxy.
 *
 *  Vite's HMR socket is the difference between a save that swaps a component
 *  and a save that reloads the page: while it is connected, the dev server
 *  pushes each update itself and the preview keeps its state. The preview
 *  announcer asks about it before broadcasting a reload, so projects whose
 *  dev server can hot-reload are not clobbered by our own full reload.
 *
 *  A count, not a flag: a preview reopened in two tabs holds two sockets, and
 *  the first one closing must not read as "no HMR" while the second still
 *  delivers updates.
 */

const open = new Map<string, number>();

export function noteHmrOpen(projectId: string): void {
  open.set(projectId, (open.get(projectId) ?? 0) + 1);
}

/** Idempotent per socket: a connection that errors often closes too. */
export function noteHmrClosed(projectId: string): void {
  const count = (open.get(projectId) ?? 0) - 1;
  if (count <= 0) open.delete(projectId);
  else open.set(projectId, count);
}

export function hasLiveHmr(projectId: string): boolean {
  return (open.get(projectId) ?? 0) > 0;
}

/** Test-only: the module is one process-wide map. */
export function resetHmrSockets(): void {
  open.clear();
}
