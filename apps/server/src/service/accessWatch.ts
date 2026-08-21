import { getProjectAccess, type AccessLevel } from "./projectAccessService.js";
import { logger } from "../lib/logger.js";

/** A level a live connection can actually hold.
 *
 *  "none" is not one of them — a connection that reaches it is closed rather
 *  than downgraded, so `onChanged` never has to describe it and neither the
 *  socket's stored level nor the `projectAccess` event has to admit it. */
export type GrantedLevel = Exclude<AccessLevel, "none">;

/** Keeps long-lived connections honest about what their holder may still do.
 *
 *  Both the editor socket and the terminal check access once, during the
 *  handshake, and then keep it in `socket.data` for the life of the
 *  connection. Nothing ever looked again. Removing a collaborator, or dropping
 *  them from editor to viewer, left their open editor and their running shell
 *  exactly as privileged as before — for as long as they kept the page open,
 *  which for someone working is all day. The same held for an access token
 *  that had since expired.
 *
 *  Rechecking on every event would put a query in front of every keystroke, so
 *  this sweeps instead: often enough that a revocation takes effect while the
 *  person removing it is still watching, cheap enough to ignore.
 */

/** How often to look again. */
const SWEEP_INTERVAL_MS = 30_000;

export interface WatchedConnection {
  userId: string;
  projectId: string;
  /** Access dropped to nothing — the project was unshared or deleted. The
   *  connection has no business continuing. */
  onRevoked: () => void;
  /** Still allowed, but at a different level. Lets a demotion to viewer take
   *  effect without throwing the person out of the page. */
  onChanged: (level: GrantedLevel) => void;
  /** What the connection currently believes, so an unchanged sweep is silent. */
  level: GrantedLevel;
}

const watched = new Map<string, WatchedConnection>();

/** Starts watching a connection. Returns a function that stops. */
export function watchAccess(id: string, connection: WatchedConnection): () => void {
  watched.set(id, connection);

  return () => {
    watched.delete(id);
  };
}

/** One pass. Exported so a test can drive it without waiting on a timer. */
export async function sweepAccess(): Promise<void> {
  // Snapshotted: a callback below may remove entries, and mutating the map
  // while iterating it would skip whatever followed.
  for (const [id, connection] of [...watched]) {
    // Still registered? A connection can close mid-sweep.
    if (!watched.has(id)) continue;

    const access = await getProjectAccess(
      connection.projectId,
      connection.userId,
    ).catch(() => null);

    if (!access || access.level === "none") {
      logger.info("closing a connection whose access was revoked", {
        projectId: connection.projectId,
        userId: connection.userId,
      });
      watched.delete(id);
      connection.onRevoked();
      continue;
    }

    if (access.level === connection.level) continue;

    // Narrowed by the branch above, which sends "none" to onRevoked.
    const granted: GrantedLevel = access.level;

    logger.info("access level changed under a live connection", {
      projectId: connection.projectId,
      from: connection.level,
      to: access.level,
    });
    connection.level = granted;
    connection.onChanged(granted);
  }
}

let timer: NodeJS.Timeout | undefined;

export function startAccessWatch(): void {
  timer = setInterval(() => {
    void sweepAccess().catch((error: unknown) => {
      logger.error("access sweep failed", error);
    });
  }, SWEEP_INTERVAL_MS);

  // Never a reason to hold the process open.
  timer.unref();
}

export function stopAccessWatch(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Only for tests, which need a clean slate between cases. */
export function resetAccessWatch(): void {
  watched.clear();
  stopAccessWatch();
}
