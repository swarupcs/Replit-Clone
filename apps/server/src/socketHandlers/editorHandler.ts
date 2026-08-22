import fs from "node:fs/promises";
import path from "node:path";
import type { Namespace, Socket } from "socket.io";
import { MAX_FILE_BYTES } from "@replit-clone/shared";
import { searchProject } from "../service/searchService.js";
import {
  applyDocUpdate,
  docsForSocket,
  dropDoc,
  dropDocsUnder,
  flushAndDropDoc,
  isLive,
  flushDoc,
  joinDoc,
  leaveDoc,
} from "../service/collabService.js";
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
import { assertUserDiskQuota } from "../service/userQuotaService.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../lib/logger.js";
import {
  getRunHistory,
  getRunState,
  autoStartRun,
  restartRun,
  startRun,
  stopRun,
  subscribe as subscribeRun,
} from "../containers/runner.js";
import {
  idleStopInSeconds,
  readContainerStats,
} from "../containers/containerManager.js";
import { installAiHandler } from "./aiHandler.js";

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

/** Room holding everyone with one file open.
 *
 *  Exported because the save announcement is raised by the flush timer in
 *  collabService, which has no socket of its own to derive it from — and two
 *  spellings of the same room is a bug that only shows up as "nothing
 *  happened".
 */
/** Largest awareness payload worth relaying. A cursor and a selection are a
 *  few hundred bytes; anything beyond this is not one. */
const MAX_AWARENESS_BYTES = 64 * 1024;

/** A simple per-socket budget for the events that do real work.
 *
 *  HTTP routes are rate limited and socket events were not, so `search`,
 *  `readFile` and `statsRequest` — each of which costs file IO or a Docker
 *  round trip — could be sent in a loop for free.
 */
class EventBudget {
  private count = 0;
  private windowStartedAt = Date.now();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** True when this call is within budget. */
  take(): boolean {
    const now = Date.now();

    if (now - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = now;
      this.count = 0;
    }

    this.count += 1;
    return this.count <= this.limit;
  }
}

export function docRoomName(projectId: string, relPath: string): string {
  return `${projectId}:doc:${relPath}`;
}

export const handleEditorSocketEvents = (
  socket: EditorSocket,
  editorNamespace: EditorNamespace,
): void => {
  const { projectId } = socket.data;

  /** True when this connection may change the project or run code in it.
   *
   *  Read at call time rather than captured once: access is rechecked while a
   *  connection is open, and a level captured at connect would keep letting
   *  someone write long after they were demoted to viewer. */
  const canEdit = (): boolean =>
    socket.data.accessLevel === "editor" || socket.data.accessLevel === "owner";

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
      if (requiresEdit && !canEdit()) {
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

  // Each scans the tree or dials Docker, so each gets a budget. Generous for a
  // person typing in a search box; not generous for a loop.
  const searchBudget = new EventBudget(30, 60_000);
  const statsBudget = new EventBudget(120, 60_000);
  const readBudget = new EventBudget(600, 60_000);

  function overBudget(action: string): boolean {
    socket.emit("error", {
      code: "TOO_MANY_REQUESTS",
      message: `Too many requests to ${action}. Slow down and try again.`,
    });
    return true;
  }

  socket.on("readFile", ({ relPath }) =>
    handle("read the file", async () => {
      if (!readBudget.take()) {
        overBudget("open files");
        return;
      }

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
      // While a file is open collaboratively the server owns writing it, and
      // a client write would clobber whatever the others have typed since.
      // The client stops sending these, so this is the belt to that braces.
      if (isLive(projectId, relPath)) return;

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
      // The owner's overall budget, not just this project's. Checked only when
      // a project was created, so it bound nothing that actually used disk.
      await assertUserDiskQuota(projectId, incoming, replacing);

      await fs.writeFile(absolute, data, "utf8");
      recordWrite(projectId, incoming, replacing);

      // To the writer, not the room. This clears a tab's unsaved marker, and
      // one person saving used to clear it for everybody with the file open —
      // telling a second editor with genuinely unsaved work that it was safe,
      // and disarming the warning when they closed the tab. A file edited
      // together is a different case, and says so with `docSaved`.
      socket.emit("writeFileSuccess", { relPath });
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
      // Before the unlink, so a flush already on the clock cannot fire in
      // between and put the file back. Discarded rather than written out:
      // saving a file somebody just asked to delete is not a save.
      dropDoc(projectId, relPath);

      await fs.unlink(resolveInProject(projectId, relPath));

      // To the room. Everyone else has to drop the tab and, more to the
      // point, the write they may have queued for it — which would otherwise
      // put the file back moments after it was deleted.
      editorNamespace.to(projectId).emit("deleteFileSuccess", { relPath });
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

      // Every file inside it is going too, so no document under it may write
      // itself back afterwards.
      dropDocsUnder(projectId, relPath);

      // `fs.rmdir` with `recursive` is deprecated and a no-op on newer Node.
      await fs.rm(absolute, { recursive: true, force: true });

      editorNamespace.to(projectId).emit("deleteFolderSuccess", { relPath });
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

      // Flushed before the move so edits from the last second travel with the
      // file, then dropped so the document cannot write itself back to a name
      // the file no longer has. Editors rejoin under the new path when their
      // tab moves.
      await flushAndDropDoc(projectId, relPath);

      await fs.rename(absolute, newAbsolute);

      // To the room: a tab left on the old path saves the file back under a
      // name it no longer has.
      editorNamespace
        .to(projectId)
        .emit("renameEntrySuccess", { relPath, newRelPath });
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

      // Same as a rename as far as the document is concerned: flush so nothing
      // in flight is lost, then drop so it cannot recreate the old path.
      await flushAndDropDoc(projectId, relPath);
      dropDocsUnder(projectId, relPath);

      await fs.mkdir(path.dirname(newAbsolute), { recursive: true });
      await fs.rename(absolute, newAbsolute);

      editorNamespace
        .to(projectId)
        .emit("moveEntrySuccess", { relPath, newRelPath });
      announceTreeChange();
    }, true)(),
  );

  // --- Shared editing ----------------------------------------------------
  //
  // Rooms are per file, so an update only reaches the people who have that
  // file open rather than everyone in the project.

  function docRoom(relPath: string): string {
    return docRoomName(projectId, relPath);
  }

  function announcePeers(relPath: string): void {
    const room = editorNamespace.adapter.rooms.get(docRoom(relPath));
    editorNamespace
      .to(docRoom(relPath))
      .emit("docPeers", { relPath, count: room?.size ?? 0 });
  }

  socket.on("docJoin", ({ relPath }) =>
    handle("open the shared document", async () => {
      const { state } = await joinDoc(projectId, relPath, socket.id);

      await socket.join(docRoom(relPath));
      socket.emit("docSync", { relPath, state: toArrayBuffer(state) });
      announcePeers(relPath);
    })(),
  );

  socket.on("docLeave", ({ relPath }) =>
    handle("close the shared document", async () => {
      await socket.leave(docRoom(relPath));
      await leaveDoc(projectId, relPath, socket.id);
      announcePeers(relPath);
    })(),
  );

  socket.on("docSave", ({ relPath }) =>
    handle(
      "save the shared document",
      async () => {
        // Only for a document this socket actually has open, so a save cannot
        // be asked for on a path the sender is not editing.
        if (!socket.rooms.has(docRoom(relPath))) return;

        await flushDoc(projectId, relPath);
        // Everyone with it open, because a shared document is one merged
        // buffer: saved for one of them is saved for all.
        editorNamespace.to(docRoom(relPath)).emit("docSaved", { relPath });
      },
      true,
    )(),
  );

  socket.on("docUpdate", ({ relPath, update }) =>
    handle(
      "apply the change",
      async () => {
        const bytes = new Uint8Array(update);
        if (!applyDocUpdate(projectId, relPath, bytes, socket.id)) return;

        // To the room minus the sender: they already have their own change,
        // and echoing it back would be pure traffic.
        socket.to(docRoom(relPath)).emit("docUpdate", { relPath, update });
        await Promise.resolve();
      },
      true,
    )(),
  );

  socket.on("docAwareness", ({ relPath, update }) => {
    // Cursors are ephemeral and never touch disk, so a viewer may broadcast
    // theirs — seeing where someone is reading is the point.
    //
    // But this was the one handler outside `handle`, relaying whatever arrived
    // for whatever path was named, at whatever size. A sender who does not
    // have the file open has no cursor in it to report, and an awareness
    // payload is a few hundred bytes at most.
    if (!socket.rooms.has(docRoom(relPath))) return;
    if (update.byteLength > MAX_AWARENESS_BYTES) return;

    socket.to(docRoom(relPath)).emit("docAwareness", { relPath, update });
  });

  // Leaving without saying so — a closed laptop, a dropped connection — must
  // still flush and release every document this socket held.
  socket.on("disconnect", () => {
    for (const entry of docsForSocket(socket.id)) {
      void leaveDoc(entry.projectId, entry.relPath, socket.id).then(() => {
        announcePeers(entry.relPath);
      });
    }
  });

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

    // Opening a project is what starts it. This is the right place for that
    // rather than the connect handler: `runSubscribe` is already the signal
    // that a client cares about the dev server, and it arrives once per
    // playground mount.
    //
    // Gated on edit access for the same reason `runStart` is — a viewer must
    // not spend the owner's container budget just by looking. Deliberately not
    // wrapped in `handle`: nobody asked for this, so it reports nothing to the
    // client and swallows its own failures (see autoStartRun).
    if (canEdit()) void autoStartRun(projectId);
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
      if (!searchBudget.take()) {
        overBudget("search");
        return;
      }

      // A user-supplied regex that does not compile is their mistake to see,
      // not a server error — buildPattern throws and `handle` reports it.
      const { matches, truncated } = await searchProject(projectId, options);
      socket.emit("searchResults", { query: options.query, matches, truncated });
    })(),
  );

  socket.on("statsRequest", () =>
    handle("read container stats", async () => {
      if (!statsBudget.take()) return;

      const stats = await readContainerStats(projectId);
      socket.emit("containerStats", {
        ...stats,
        idleStopInSeconds: idleStopInSeconds(projectId),
      });
    })(),
  );

  // Owns its own in-flight state and its own error channel, so it registers
  // its handlers rather than borrowing `handle`.
  installAiHandler(socket);

  socket.on("disconnect", releaseRelay);
};

/** socket.io sends a Buffer as-is; the browser wants an ArrayBuffer. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
