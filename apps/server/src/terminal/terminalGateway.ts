import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import {
  attach,
  detach,
  ensureContainer,
} from "../containers/containerManager.js";
import {
  bindSocketToSession,
  handleTerminalCreation,
} from "../containers/handleTerminalCreation.js";
import type { AttachInput } from "../containers/handleTerminalCreation.js";
import { assertProjectAccess, touchProject } from "../service/projectService.js";
import { verifyAccessToken } from "../service/tokenService.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import { logger } from "../lib/logger.js";
import { watchAccess } from "../service/accessWatch.js";
import { increment } from "../lib/metrics.js";
import { AppError } from "../utils/errors.js";
import {
  endUserSessions,
  findSession,
  isValidClientKey,
  makeRoomForSession,
  sessionId,
} from "./terminalSessions.js";

/** Decodes a client frame to text.
 *
 *  `ws` hands over a Buffer, an ArrayBuffer, or — for a fragmented message —
 *  an array of Buffers. Calling `.toString()` on the last of those returns the
 *  fragments joined by commas rather than the text, so a long paste or a large
 *  terminal frame arrived corrupted.
 */
function decodeMessage(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

/** Reads the access token from the WebSocket subprotocol.
 *
 *  The browser WebSocket API cannot set an Authorization header, and a token in
 *  the query string ends up in access logs, so the client sends
 *  `new WebSocket(url, ["auth", token])` and we read the value after "auth".
 */
function tokenFromRequest(req: IncomingMessage): string | undefined {
  const raw = req.headers["sec-websocket-protocol"];
  if (!raw) return undefined;

  const parts = (Array.isArray(raw) ? raw.join(",") : raw)
    .split(",")
    .map((part) => part.trim());

  const authIndex = parts.indexOf("auth");
  return authIndex >= 0 ? parts[authIndex + 1] : undefined;
}

/** Mounts the terminal WebSocket on the MAIN http server.
 *
 *  This used to be an entirely separate Express app on its own port, with its
 *  own copy of the middleware and no npm script to start it. One process, one
 *  port, one place where auth is enforced.
 */
/** Distinguishes one terminal from another. It names the file the shell
 *  records its pid in, and is stable for the life of a session however many
 *  sockets render it. */
let terminalCounter = 0;

function nextTerminalId(): number {
  terminalCounter += 1;
  return terminalCounter;
}

/** Names one CONNECTION's access watch, which is not the same thing as naming
 *  a terminal.
 *
 *  It used to be `terminal:<terminalId>`, and that was right while a terminal
 *  had exactly one socket for its whole life. Since §13.7 it can have several:
 *  a reconnect, or a second window taking one over. `watchAccess` is a map
 *  keyed by this string and its release deletes that key, so two sockets
 *  sharing an id means the departing one deletes the watch belonging to the
 *  one that replaced it — and the terminal that is left running is the one
 *  nothing is checking any more. Exactly the hole `watchAccess` was written to
 *  close, reopened by giving a shell more than one socket.
 */
let watchCounter = 0;

function nextWatchId(): string {
  watchCounter += 1;
  return `terminal-connection:${String(watchCounter)}`;
}

export function installTerminalGateway(server: Server): void {
  // `noServer` so we own the upgrade and can reject before allocating a socket.
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // socket.io and the preview proxy handle their own upgrades.
    if (!url.pathname.startsWith("/terminal")) return;

    void (async () => {
      try {
        const token = tokenFromRequest(req);
        if (!token) throw new Error("Missing access token");

        const claims = verifyAccessToken(token);

        const projectId = assertValidProjectId(
          url.searchParams.get("projectId") ?? "",
        );

        // What the client calls this terminal, so a reconnect can ask for the
        // shell it already had rather than a new one (plan.md §13.7). Absent
        // or malformed means "just give me a terminal", which is what every
        // client did before this existed — so an old client still works and
        // simply does not survive a disconnect.
        const clientKey = url.searchParams.get("session") ?? "";
        const wantsSession = isValidClientKey(clientKey);

        // A terminal is a shell inside the project's container, so it needs the
        // same ownership check as any other project operation.
        // A shell can write anything the project can, so read-only access is
        // not enough for one.
        const project = await assertProjectAccess(projectId, claims.sub, "editor");

        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          // Buffer client input from the instant the socket exists. Starting
          // the container and the exec is asynchronous, but the terminal sends
          // its initial resize the moment it connects — without this the PTY
          // stayed at 0x0 and every early keystroke was dropped.
          const inbox: string[] = [];
          let sink: ((data: string) => void) | null = null;

          ws.on("message", (data) => {
            const text = decodeMessage(data);
            if (sink) sink(text);
            else inbox.push(text);
          });

          const attachInput = (handler: (data: string) => void): void => {
            sink = handler;
            for (const buffered of inbox.splice(0)) handler(buffered);
          };

          const id = wantsSession
            ? sessionId(claims.sub, projectId, clientKey)
            : undefined;

          // The reconnect path, and it is deliberately short: a session that
          // is still here already has a container, an attachment, an exec and
          // a pty, so none of that is done again. `ensureContainer` in
          // particular is skipped — the session is holding the container up.
          const existing = id ? findSession(id) : undefined;

          if (existing) {
            increment("terminal_reattached");

            // Somebody is working in this project again, which is what
            // `touchProject` records — the reconnect path skips
            // `startTerminal`, so without this a workspace somebody used all
            // day through one reconnecting terminal would report the time of
            // its first connection as its last activity. Not awaited: a
            // reattach must not wait on a write nobody reads back here.
            void touchProject(projectId).catch(() => {
              // Best effort. A missed touch is a wrong timestamp, not a
              // broken terminal.
            });

            watchTerminalAccess(ws, claims.sub, projectId);
            bindSocketToSession(existing, ws, attachInput);
            return;
          }

          // One id per terminal, naming the file its shell records its pid
          // in. Not the watch id — see `nextWatchId`.
          const terminalId = nextTerminalId();
          watchTerminalAccess(ws, claims.sub, projectId);

          void startTerminal(
            ws,
            projectId,
            project.template,
            attachInput,
            terminalId,
            project.startCommand ?? undefined,
            id,
          );
        });
      } catch (error) {
        logger.warn("terminal upgrade rejected", {
          reason: error instanceof Error ? error.message : String(error),
        });
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
      }
    })();
  });
}

/** Keeps one terminal's authorisation live for as long as its socket is.
 *
 *  A shell is the most privileged thing on offer here, and its authorisation
 *  was checked once at the upgrade and never again. Someone removed from a
 *  project kept a working shell inside its container until they closed the tab.
 *
 *  **And revocation now has to end the session, not just the socket.** Before
 *  §13.7 closing the socket WAS ending the shell. It is not any more: a
 *  detached session goes on running for its grace window, so a revocation that
 *  only closed the socket would leave a shell inside somebody's container
 *  belonging to a person who has just lost access to it — and would hand it
 *  back to them if they reconnected inside the window.
 */
function watchTerminalAccess(
  ws: WebSocket,
  userId: string,
  projectId: string,
): void {
  const cutOff = (code: number, message: string): void => {
    endUserSessions(userId, projectId, "access-revoked");
    ws.close(code, message);
  };

  const releaseAccessWatch = watchAccess(nextWatchId(), {
    userId,
    projectId,
    level: "editor",
    onRevoked: () => {
      cutOff(4403, "Your access to this project was removed");
    },
    // A demotion to viewer is the same thing for a terminal: read-only
    // access does not include a shell that can write the whole tree.
    onChanged: (level) => {
      if (level === "viewer") {
        cutOff(4403, "You no longer have write access to this project");
      }
    },
  });

  ws.on("close", releaseAccessWatch);
}

async function startTerminal(
  ws: WebSocket,
  projectId: string,
  templateId: string,
  attachInput: AttachInput,
  terminalId: number,
  startCommand?: string,
  /** The session to register this shell under, when the client named one. */
  id?: string,
): Promise<void> {
  attach(projectId);

  // Released exactly once, by whichever path gets there first. The failure
  // path used to call `detach` directly AND leave the close handler in place,
  // so a terminal that could not start decremented the project's attachment
  // count twice — releasing an attachment that belonged to somebody else's
  // editor socket, and letting the idle sweeper stop a container still in use.
  let released = false;
  const releaseAttachment = (): void => {
    if (released) return;
    released = true;
    detach(projectId);
  };

  // Without a session the socket owns the attachment, exactly as before. With
  // one, ownership moves to the session below — a detached terminal running a
  // build is using this container, and the reaper must not stop it.
  if (!id) ws.on("close", releaseAttachment);

  try {
    await touchProject(projectId);

    const container = await ensureContainer(projectId);

    // The client can go away while the container is starting, and routinely
    // does: React's StrictMode opens a socket and discards it on every mount,
    // in development. Opening a shell for a socket nobody is holding leaves a
    // /bin/bash running inside the container with nothing attached to it and
    // nothing left that would ever close it.
    if (ws.readyState !== ws.OPEN) {
      releaseAttachment();
      return;
    }

    // Room for one more shell against the container's pid limit, given that a
    // shell now outlives its socket. Detached sessions are given up to make
    // it; only a project whose every terminal has somebody watching it is
    // refused, and then the reason says so rather than the socket just closing.
    if (id && !makeRoomForSession(projectId)) {
      releaseAttachment();
      ws.close(4004, "Too many terminals open on this project");
      return;
    }

    // Counted here rather than on arrival, so the metric means "shells opened"
    // and not "sockets seen". It read 11 for a project that never had more
    // than a couple of shells in it.
    increment("terminal_sessions");
    handleTerminalCreation(
      container,
      ws,
      templateId,
      attachInput,
      terminalId,
      startCommand,
      id ? { id, projectId, release: releaseAttachment } : undefined,
    );
  } catch (error) {
    logger.error("could not start terminal", error, { projectId });
    releaseAttachment();
    // Relay the real reason when it is safe to show (an AppError, e.g. the
    // at-capacity 503), so the terminal can tell the user to close a project
    // instead of showing a bare "Disconnected". WebSocket close reasons are
    // capped at 123 UTF-8 bytes, so keep it short.
    const reason =
      error instanceof AppError
        ? error.message
        : "Could not start the project container";
    ws.close(1011, reason.slice(0, 120));
  }
}
