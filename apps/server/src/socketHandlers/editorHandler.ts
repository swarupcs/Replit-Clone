import fs from "node:fs/promises";
import path from "node:path";
import type { Namespace, Socket } from "socket.io";
import { MAX_FILE_BYTES } from "@replit-clone/shared";
import { searchProject } from "../service/searchService.js";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from "@replit-clone/shared";
import { resolveInProject } from "../utils/projectPaths.js";
import {
  assertWithinQuota,
  recordWrite,
} from "../service/diskUsageService.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../lib/logger.js";
import {
  getRunHistory,
  getRunState,
  restartRun,
  startRun,
  stopRun,
  subscribe as subscribeRun,
} from "../containers/runner.js";
import {
  idleStopInSeconds,
  readContainerStats,
} from "../containers/containerManager.js";

export type EditorSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export type EditorNamespace = Namespace<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Forwards a project's run events into its room, once.
 *
 *  Every connection used to take out its own subscription, and each of those
 *  listeners broadcast to the whole room — so N tabs on one project turned a
 *  single chunk of output into N listeners each emitting to N clients, and the
 *  log rendered every line N times. The relay is per project and refcounted:
 *  the first socket to arrive creates it, the last to leave tears it down.
 */
const relays = new Map<string, { release: () => void; sockets: number }>();

function retainRunRelay(
  projectId: string,
  editorNamespace: EditorNamespace,
): () => void {
  const existing = relays.get(projectId);

  if (existing) {
    existing.sockets += 1;
  } else {
    const unsubscribe = subscribeRun(projectId, (event) => {
      if (event.type === "state") {
        editorNamespace.to(projectId).emit("runState", event.state);
      } else if (event.type === "ready") {
        editorNamespace.to(projectId).emit("previewReady", { port: event.port });
      } else {
        editorNamespace.to(projectId).emit("runOutput", { chunk: event.chunk });
      }
    });

    relays.set(projectId, { release: unsubscribe, sockets: 1 });
  }

  let released = false;

  // Guarded because socket.io can emit `disconnect` handlers more than once
  // during a reconnect storm, and a double release would drop the relay while
  // other tabs still depend on it.
  return () => {
    if (released) return;
    released = true;

    const relay = relays.get(projectId);
    if (!relay) return;

    relay.sockets -= 1;
    if (relay.sockets > 0) return;

    relay.release();
    relays.delete(projectId);
  };
}

export const handleEditorSocketEvents = (
  socket: EditorSocket,
  editorNamespace: EditorNamespace,
): void => {
  const { projectId, accessLevel } = socket.data;

  /** True when this connection may change the project or run code in it. */
  const canEdit = accessLevel === "editor" || accessLevel === "owner";

  /** Runs a handler with uniform error reporting.
   *
   *  A path that escapes the project root surfaces as a typed error rather
   *  than a filesystem operation, and unexpected failures never leak an
   *  internal message or a host path to the client.
   */
  function handle(
    action: string,
    fn: () => Promise<void>,
    requiresEdit = false,
  ): () => Promise<void> {
    return async () => {
      // Checked per event rather than at connect: a viewer is allowed to
      // connect precisely so they can read, so the line has to be drawn
      // around the events that write or execute.
      if (requiresEdit && !canEdit) {
        socket.emit("error", {
          code: "READ_ONLY",
          message: `You have read-only access and cannot ${action}`,
        });
        return;
      }

      try {
        await fn();
      } catch (error) {
        if (error instanceof AppError) {
          socket.emit("error", { code: error.code, message: error.message });
          return;
        }
        logger.error("editor operation failed", error, { action, projectId });
        socket.emit("error", {
          code: "OPERATION_FAILED",
          message: `Could not ${action}`,
        });
      }
    };
  }

  /** Tells every other socket in this project to refetch the tree. Scoped to
   *  the project room — success events previously went to the entire
   *  namespace, leaking other users' file paths. */
  function announceTreeChange(): void {
    editorNamespace.to(projectId).emit("treeChanged");
  }

  socket.on("readFile", ({ relPath }) =>
    handle("read the file", async () => {
      const absolute = resolveInProject(projectId, relPath);

      const stats = await fs.stat(absolute);
      if (stats.size > MAX_FILE_BYTES) {
        socket.emit("error", {
          code: "FILE_TOO_LARGE",
          message: "File is too large to open in the editor",
        });
        return;
      }

      const contents = await fs.readFile(absolute, "utf8");
      socket.emit("readFileSuccess", { relPath, value: contents });
    })(),
  );

  socket.on("writeFile", ({ relPath, data }) =>
    handle("write the file", async () => {
      const absolute = resolveInProject(projectId, relPath);

      // Reads were already capped; writes were not, so a client could put a
      // file of any size on the host through a socket the editor opens anyway.
      const incoming = Buffer.byteLength(data, "utf8");
      if (incoming > MAX_FILE_BYTES) {
        socket.emit("error", {
          code: "FILE_TOO_LARGE",
          message: "File is too large to save from the editor",
        });
        return;
      }

      // Measured against what this write replaces, so saving a file that has
      // shrunk is never refused for being over quota.
      const existing = await fs.stat(absolute).catch(() => undefined);
      const replacing = existing?.size ?? 0;
      await assertWithinQuota(projectId, incoming, replacing);

      await fs.writeFile(absolute, data, "utf8");
      recordWrite(projectId, incoming, replacing);

      editorNamespace.to(projectId).emit("writeFileSuccess", { relPath });
    }, true)(),
  );

  socket.on("createFile", ({ relPath }) =>
    handle("create the file", async () => {
      const absolute = resolveInProject(projectId, relPath);

      // `fs.stat` REJECTS when the path is absent, so the original truthiness
      // check never fired and an existing file was silently truncated.
      if (await exists(absolute)) {
        socket.emit("error", {
          code: "ALREADY_EXISTS",
          message: "A file with that name already exists",
        });
        return;
      }

      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, "", "utf8");

      socket.emit("createFileSuccess", { relPath });
      announceTreeChange();
    }, true)(),
  );

  socket.on("deleteFile", ({ relPath }) =>
    handle("delete the file", async () => {
      await fs.unlink(resolveInProject(projectId, relPath));

      socket.emit("deleteFileSuccess", { relPath });
      announceTreeChange();
    }, true)(),
  );

  socket.on("createFolder", ({ relPath }) =>
    handle("create the folder", async () => {
      const absolute = resolveInProject(projectId, relPath);

      if (await exists(absolute)) {
        socket.emit("error", {
          code: "ALREADY_EXISTS",
          message: "A folder with that name already exists",
        });
        return;
      }

      await fs.mkdir(absolute, { recursive: true });

      socket.emit("createFolderSuccess", { relPath });
      announceTreeChange();
    }, true)(),
  );

  socket.on("deleteFolder", ({ relPath }) =>
    handle("delete the folder", async () => {
      const absolute = resolveInProject(projectId, relPath);

      // Deleting the project root itself would empty the bind mount.
      if (relPath === "" || relPath === "." || relPath === "/") {
        socket.emit("error", {
          code: "FORBIDDEN",
          message: "Cannot delete the project root",
        });
        return;
      }

      // `fs.rmdir` with `recursive` is deprecated and a no-op on newer Node.
      await fs.rm(absolute, { recursive: true, force: true });

      socket.emit("deleteFolderSuccess", { relPath });
      announceTreeChange();
    }, true)(),
  );

  socket.on("renameEntry", ({ relPath, newName }) =>
    handle("rename", async () => {
      // A name, not a path: allowing separators here would be a traversal
      // vector through the destination argument.
      if (!newName || /[/\0]/.test(newName) || newName === "." || newName === "..") {
        socket.emit("error", {
          code: "INVALID_NAME",
          message: "Name cannot contain a path separator",
        });
        return;
      }

      const absolute = resolveInProject(projectId, relPath);
      const parentRelPath = path.posix.dirname(relPath);
      const newRelPath =
        parentRelPath === "." ? newName : `${parentRelPath}/${newName}`;
      const newAbsolute = resolveInProject(projectId, newRelPath);

      if (await exists(newAbsolute)) {
        socket.emit("error", {
          code: "ALREADY_EXISTS",
          message: "Something with that name already exists",
        });
        return;
      }

      await fs.rename(absolute, newAbsolute);

      socket.emit("renameEntrySuccess", { relPath, newRelPath });
      announceTreeChange();
    }, true)(),
  );

  socket.on("moveEntry", ({ relPath, destDir }) =>
    handle("move", async () => {
      // Both ends go through resolveInProject, so neither the source nor the
      // destination can point outside the project however they are spelled.
      const absolute = resolveInProject(projectId, relPath);
      const name = path.posix.basename(relPath);

      const newRelPath = destDir ? `${destDir}/${name}` : name;
      const newAbsolute = resolveInProject(projectId, newRelPath);

      if (absolute === newAbsolute) return;

      // Moving a folder into itself would detach the subtree entirely.
      if (newAbsolute.startsWith(absolute + path.sep)) {
        socket.emit("error", {
          code: "INVALID_MOVE",
          message: "A folder cannot be moved inside itself",
        });
        return;
      }

      if (await exists(newAbsolute)) {
        socket.emit("error", {
          code: "ALREADY_EXISTS",
          message: `"${name}" already exists there`,
        });
        return;
      }

      await fs.mkdir(path.dirname(newAbsolute), { recursive: true });
      await fs.rename(absolute, newAbsolute);

      socket.emit("moveEntrySuccess", { relPath, newRelPath });
      announceTreeChange();
    }, true)(),
  );

  // --- Dev server (the Run button) ---------------------------------------
  //
  // Run state is per PROJECT, not per socket: two tabs on the same project
  // must agree about whether the dev server is up, so updates go to the room.

  const releaseRelay = retainRunRelay(projectId, editorNamespace);

  socket.on("runSubscribe", () => {
    // Replays the log so a client that connects to an already-running dev
    // server does not show an empty pane under a "running" badge.
    socket.emit("runState", getRunState(projectId));
    socket.emit("runHistory", { chunks: getRunHistory(projectId) });
  });

  socket.on("runStart", () =>
    handle("start the dev server", async () => {
      await startRun(projectId);
    }, true)(),
  );

  socket.on("runStop", () =>
    handle("stop the dev server", async () => {
      await stopRun(projectId);
    }, true)(),
  );

  socket.on("runRestart", () =>
    handle("restart the dev server", async () => {
      await restartRun(projectId);
    }, true)(),
  );

  socket.on("search", (options) =>
    handle("search the project", async () => {
      // A user-supplied regex that does not compile is their mistake to see,
      // not a server error — buildPattern throws and `handle` reports it.
      const { matches, truncated } = await searchProject(projectId, options);
      socket.emit("searchResults", { query: options.query, matches, truncated });
    })(),
  );

  socket.on("statsRequest", () =>
    handle("read container stats", async () => {
      const stats = await readContainerStats(projectId);
      socket.emit("containerStats", {
        ...stats,
        idleStopInSeconds: idleStopInSeconds(projectId),
      });
    })(),
  );

  socket.on("disconnect", releaseRelay);
};
