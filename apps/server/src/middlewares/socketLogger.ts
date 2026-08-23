import type { Namespace, Socket } from "socket.io";
import { logger, newRequestId, withLogContext } from "../lib/logger.js";

/** What `installSocketAuth` has already put on the socket by the time this
 *  middleware runs — they are registered in that order on the namespace. */
interface AuthedSocketData {
  userId: string;
  projectId: string;
}

type HandshakeMiddleware = (
  socket: Socket,
  next: (error?: Error) => void,
) => void;

type PacketMiddleware = (
  packet: unknown[],
  next: (error?: Error) => void,
) => void;

/** The socket half of the request logger.
 *
 *  Every recent bug — save races, run state, watcher events — played out over
 *  socket.io, where the HTTP request logger sees nothing at all: the handshake
 *  is one anonymous upgrade and the events are not requests. This gives each
 *  connection one correlation id and re-enters the AsyncLocalStorage context
 *  for every inbound event, so a log line written deep inside an event handler
 *  carries the same id the connection was admitted under.
 *
 *  Must be registered AFTER `installSocketAuth`, whose job it is to reject
 *  strangers and fill in `socket.data`; a rejected handshake is logged by
 *  socket.io itself and never reaches here.
 */
export function installSocketLogger(namespace: Namespace): void {
  namespace.use(((socket, next) => {
    const { userId, projectId } = socket.data as AuthedSocketData;
    const context = { requestId: newRequestId(), userId, projectId };

    withLogContext(context, () => {
      logger.info("socket connected", { transport: socket.conn?.transport?.name });
    });

    // socket.io dispatches to the handler synchronously after next(), inside
    // the context established here — so it flows into the handler's async work.
    socket.use(((packet, next) => {
      withLogContext(context, () => {
        logger.debug("socket event", { event: String(packet[0]) });
        next();
      });
    }) as PacketMiddleware);

    socket.on("disconnect", (reason) => {
      withLogContext(context, () => {
        // The id spelled out because the disconnect often lands long after
        // whatever was being traced — the line has to stand on its own.
        logger.info("socket disconnected", {
          requestId: context.requestId,
          reason: String(reason),
        });
      });
    });

    next();
  }) as HandshakeMiddleware);
}
