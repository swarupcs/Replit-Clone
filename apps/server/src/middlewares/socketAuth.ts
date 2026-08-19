import type { Namespace } from "socket.io";
import { verifyAccessToken } from "../service/tokenService.js";
import { assertProjectAccess } from "../service/projectService.js";

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

        if (!token) {
          next(new Error("UNAUTHORIZED: missing access token"));
          return;
        }

        const claims = verifyAccessToken(token);

        const projectId = socket.handshake.query["projectId"];
        if (typeof projectId !== "string" || projectId.length === 0) {
          next(new Error("BAD_REQUEST: projectId is required"));
          return;
        }

        await assertProjectAccess(projectId, claims.sub);

        socket.data.userId = claims.sub;
        socket.data.projectId = projectId;
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
