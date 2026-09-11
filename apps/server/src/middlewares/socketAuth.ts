import type { Namespace } from "socket.io";
import { verifyAccessToken, verifyPairingToken } from "../service/tokenService.js";
import { getProjectAccess } from "../service/projectAccessService.js";
import { pairingAccess } from "../service/pairingService.js";

/** socket.io handshake auth.
 *
 *  The editor namespace previously accepted any connection and trusted a
 *  projectId from the query string, so anyone who could reach the port had full
 *  filesystem access. A socket now must present a valid access token AND own
 *  the project it names before any handler is registered.
 */
export function installSocketAuth(namespace: Namespace): void {
  namespace.use((socket, next) => {
    void (async () => {
      try {
        const token =
          (socket.handshake.auth?.["token"] as string | undefined) ??
          extractBearer(socket.handshake.headers.authorization);

        // A guest has a pairing token and no access token, so the absence of
        // one is only fatal when the other is absent too.
        if (!token && !socket.handshake.auth?.["pairing"]) {
          next(new Error("UNAUTHORIZED: missing access token"));
          return;
        }

        const projectId = socket.handshake.query["projectId"];
        if (typeof projectId !== "string" || projectId.length === 0) {
          next(new Error("BAD_REQUEST: projectId is required"));
          return;
        }

        // A guest paired in by link, with no account at all. plan.md §13.6.
        //
        // Tried FIRST and separately, never as a fallback after an access
        // token fails: the two are different credentials with different
        // scopes, and `verifyPairingToken` refuses an access token exactly as
        // `verifyAccessToken` refuses this one. What makes it safe is the
        // token's own `pid` — `pairingAccess` compares it against the project
        // being joined, so a token for one project is worthless against
        // another.
        const guest = socket.handshake.auth?.["pairing"] as string | undefined;
        if (guest) {
          const claims = verifyPairingToken(guest);
          const access = await pairingAccess(claims, projectId);
          if (!access) {
            next(new Error("NOT_FOUND: project not found"));
            return;
          }

          socket.data.userId = claims.sub;
          socket.data.projectId = projectId;
          socket.data.accessLevel = access.level;
          // Marked, because a guest is not a user: anything that reads a
          // `userId` expecting a row in `users` must be able to tell.
          socket.data.guest = true;
          socket.data.guestName = claims.nam;
          next();
          return;
        }

        // Narrowed here rather than at the guard above: that guard now
        // accepts a request carrying only a pairing token, and by this line
        // the guest branch has already returned.
        if (!token) {
          next(new Error("UNAUTHORIZED: missing access token"));
          return;
        }

        const claims = verifyAccessToken(token);

        // Viewer is enough to CONNECT — read-only access exists so someone
        // can look at a project. Which events they may then send is decided
        // per event by the handler, from the level recorded here.
        const access = await getProjectAccess(projectId, claims.sub);
        if (!access || access.level === "none") {
          next(new Error("NOT_FOUND: project not found"));
          return;
        }

        socket.data.userId = claims.sub;
        socket.data.projectId = projectId;
        socket.data.accessLevel = access.level;
        next();
      } catch (error) {
        next(
          error instanceof Error ? error : new Error("UNAUTHORIZED"),
        );
      }
    })();
  });
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}
