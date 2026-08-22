import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const collab = vi.hoisted(() => ({
  applyDocUpdate: vi.fn<() => boolean>(() => true),
  docsForSocket: vi.fn<
    () => Array<{ projectId: string; relPath: string }>
  >(() => []),
  dropDoc: vi.fn(),
  dropDocsUnder: vi.fn(),
  flushAndDropDoc: vi.fn(() => Promise.resolve(undefined)),
  isLive: vi.fn<() => boolean>(() => false),
  flushDoc: vi.fn(() => Promise.resolve(undefined)),
  joinDoc: vi.fn(() => ({ state: new Uint8Array([1, 2, 3]) })),
  // The disconnect handler chains `.then` on the result, so it must be a
  // thenable even though the mock body has nothing to await.
  leaveDoc: vi.fn(() => Promise.resolve(undefined)),
}));

/** One entry from the runner's subscribe channel. */
interface RunEvent {
  type: string;
  chunk?: string;
  state?: string;
  port?: number;
}

const runner = vi.hoisted(() => ({
  getRunHistory: vi.fn<() => string[]>(() => []),
  getRunState: vi.fn<() => string>(() => "idle"),
  // The runSubscribe handler chains `.catch().then()` on reconcileRun's result.
  reconcileRun: vi.fn(() => Promise.resolve(undefined)),
  autoStartRun: vi.fn(() => Promise.resolve(undefined)),
  restartRun: vi.fn(() => Promise.resolve(undefined)),
  startRun: vi.fn(() => Promise.resolve(undefined)),
  stopRun: vi.fn(() => Promise.resolve(undefined)),
  subscribe: vi.fn<
    (projectId: string, listener: (event: RunEvent) => void) => () => void
  >(() => () => {}),
}));

const containerManager = vi.hoisted(() => ({
  idleStopInSeconds: vi.fn(() => 300),
  readContainerStats: vi.fn(() => Promise.resolve({ cpuPercent: 1, memoryMB: 2 })),
}));

const searchProject = vi.hoisted(() =>
  vi.fn<() => Promise<{ matches: unknown[]; truncated: boolean }>>(() =>
    Promise.resolve({ matches: [], truncated: false }),
  ),
);

const replaceInProject = vi.hoisted(() =>
  vi.fn<
    () => Promise<{
      files: { relPath: string; replacements: number }[];
      replacements: number;
      truncated: boolean;
    }>
  >(() => Promise.resolve({ files: [], replacements: 0, truncated: false })),
);

vi.mock("../service/collabService.js", () => collab);
vi.mock("../containers/runner.js", () => runner);
vi.mock("../containers/containerManager.js", () => containerManager);
vi.mock("../service/searchService.js", () => ({
  searchProject,
  replaceInProject,
}));
vi.mock("./aiHandler.js", () => ({ installAiHandler: vi.fn() }));
vi.mock("../service/diskUsageService.js", () => ({
  assertWithinQuota: vi.fn(() => Promise.resolve(undefined)),
  recordWrite: vi.fn(),
}));
vi.mock("../service/userQuotaService.js", () => ({
  assertUserDiskQuota: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
}));

import { handleEditorSocketEvents } from "./editorHandler.js";
import { docRoomName } from "./editorHandler.js";
import { projectRoot } from "../utils/projectPaths.js";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const USER = { sub: "11111111-1111-4111-8111-111111111111", email: "a@example.com" };
const ROOT = projectRoot(PROJECT);

type Handler = (payload: unknown) => unknown;

/** A stand-in socket that records what it was asked to listen for, what it
 *  emitted back, and which rooms it joined — everything the handler needs. */
function makeSocket(accessLevel: "owner" | "editor" | "viewer") {
  // A list per event: the handler registers "disconnect" more than once.
  const handlers = new Map<string, Handler[]>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const toEmits: Array<{ room: string; event: string; payload: unknown }> = [];
  const rooms = new Set<string>(["socket-1"]);

  const socket = {
    id: "socket-1",
    data: { userId: USER.sub, projectId: PROJECT, accessLevel },
    rooms,
    on(event: string, fn: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    emit(event: string, payload: unknown) {
      emitted.push({ event, payload });
    },
    join(room: string) {
      rooms.add(room);
    },
    leave(room: string) {
      rooms.delete(room);
    },
    to(room: string) {
      return {
        emit: (event: string, payload: unknown) => {
          toEmits.push({ room, event, payload });
        },
      };
    },
  };

  return {
    socket,
    handlers,
    emitted,
    toEmits,
    rooms,
    /** Fires one client event and waits for every registered handler. */
    send: (event: string, payload: unknown) => {
      const fns = handlers.get(event);
      if (!fns?.length) throw new Error(`no handler registered for ${event}`);
      return Promise.all(fns.map((fn) => fn(payload)));
    },
  };
}

/** A stand-in namespace: room broadcasts are recorded, and the adapter's room
 *  map backs `announcePeers`'s membership count. */
function makeNamespace() {
  const roomEmits: Array<{ room: string; event: string; payload: unknown }> = [];
  const adapterRooms = new Map<string, Set<string>>();

  const namespace = {
    adapter: { rooms: adapterRooms },
    to(room: string) {
      return {
        emit: (event: string, payload: unknown) => {
          roomEmits.push({ room, event, payload });
        },
      };
    },
  };

  return { namespace, roomEmits, adapterRooms };
}

/** Installs the handler on a fresh socket/namespace pair. */
function connect(
  accessLevel: "owner" | "editor" | "viewer" = "editor",
  projectId: string = PROJECT,
) {
  const client = makeSocket(accessLevel);
  client.socket.data.projectId = projectId;
  const ns = makeNamespace();
  handleEditorSocketEvents(
    client.socket as never,
    ns.namespace as never,
  );
  return { ...client, ...ns };
}

beforeEach(async () => {
  vi.clearAllMocks();
  runner.getRunState.mockReturnValue("idle");
  runner.getRunHistory.mockReturnValue([]);
  searchProject.mockResolvedValue({ matches: [], truncated: false });
  replaceInProject.mockResolvedValue({ files: [], replacements: 0, truncated: false });

  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
});

describe("editorHandler: file operations", () => {
  it("reads a file back to the asking socket", async () => {
    await fs.writeFile(`${ROOT}/a.txt`, "hello", "utf8");
    const c = connect();

    await c.send("readFile", { relPath: "a.txt" });

    expect(c.emitted).toContainEqual({
      event: "readFileSuccess",
      payload: { relPath: "a.txt", value: "hello" },
    });
  });

  it("refuses to read a path outside the project", async () => {
    const c = connect();

    await c.send("readFile", { relPath: "../../secrets.txt" });

    expect(c.emitted).toContainEqual(
      expect.objectContaining({
        event: "error",
        payload: expect.objectContaining({ code: "PATH_TRAVERSAL" }),
      }),
    );
  });

  it("reports a missing file without leaking the host's message", async () => {
    const c = connect();

    await c.send("readFile", { relPath: "nope.txt" });

    expect(c.emitted).toContainEqual({
      event: "error",
      payload: { code: "OPERATION_FAILED", message: "Could not read the file" },
    });
  });

  it("writes a file and confirms to the writer alone", async () => {
    const c = connect();

    await c.send("writeFile", { relPath: "a.txt", data: "typed" });

    expect(await fs.readFile(`${ROOT}/a.txt`, "utf8")).toBe("typed");
    expect(c.emitted).toContainEqual({
      event: "writeFileSuccess",
      payload: { relPath: "a.txt" },
    });
    expect(c.toEmits).toHaveLength(0);
  });

  /** While a document is shared the server owns writing it; a stray client
   *  write would clobber what the others have typed since. */
  it("ignores a client write to a live shared document", async () => {
    collab.isLive.mockReturnValue(true);
    const c = connect();

    await c.send("writeFile", { relPath: "a.txt", data: "clobber" });

    expect(await fs.stat(`${ROOT}/a.txt`).catch(() => "absent")).toBe("absent");
    expect(c.emitted).toHaveLength(0);
  });

  it("refuses every write-shaped event from a viewer", async () => {
    const c = connect("viewer");

    for (const [event, payload] of [
      ["writeFile", { relPath: "a.txt", data: "x" }],
      ["createFile", { relPath: "a.txt" }],
      ["deleteFile", { relPath: "a.txt" }],
      ["createFolder", { relPath: "d" }],
      ["deleteFolder", { relPath: "d" }],
      ["renameEntry", { relPath: "a.txt", newName: "b.txt" }],
      ["moveEntry", { relPath: "a.txt", destDir: "d" }],
      ["replaceInProject", { search: { query: "a" }, replacement: "b" }],
      ["runStart", undefined],
      ["runStop", undefined],
      ["runRestart", undefined],
    ] as const) {
      c.emitted.length = 0;
      await c.send(event, payload);
      expect(c.emitted, event).toEqual([
        { event: "error", payload: expect.objectContaining({ code: "READ_ONLY" }) },
      ]);
    }
  });

  /** `fs.stat` rejects when the path is absent, so an existence check written
   *  as a truthy result once let createFile silently truncate the file. */
  it("refuses to create a file that already exists, leaving it intact", async () => {
    await fs.writeFile(`${ROOT}/a.txt`, "keep me", "utf8");
    const c = connect();

    await c.send("createFile", { relPath: "a.txt" });

    expect(c.emitted).toContainEqual(
      expect.objectContaining({
        event: "error",
        payload: expect.objectContaining({ code: "ALREADY_EXISTS" }),
      }),
    );
    expect(await fs.readFile(`${ROOT}/a.txt`, "utf8")).toBe("keep me");
  });

  it("deletes a file and tells the whole project room", async () => {
    await fs.writeFile(`${ROOT}/a.txt`, "x", "utf8");
    const c = connect();

    await c.send("deleteFile", { relPath: "a.txt" });

    expect(await fs.stat(`${ROOT}/a.txt`).catch(() => "absent")).toBe("absent");
    expect(collab.dropDoc).toHaveBeenCalledWith(PROJECT, "a.txt");
    expect(c.roomEmits).toContainEqual({
      room: PROJECT,
      event: "deleteFileSuccess",
      payload: { relPath: "a.txt" },
    });
    expect(c.roomEmits).toContainEqual({ room: PROJECT, event: "treeChanged", payload: undefined });
  });

  it("refuses to delete the project root", async () => {
    const c = connect();

    await c.send("deleteFolder", { relPath: "" });

    expect(c.emitted).toContainEqual(
      expect.objectContaining({
        event: "error",
        payload: expect.objectContaining({ code: "FORBIDDEN" }),
      }),
    );
    expect(c.roomEmits).toHaveLength(0);
  });

  it("renames within the parent directory and announces the new path", async () => {
    await fs.writeFile(`${ROOT}/a.txt`, "x", "utf8");
    const c = connect();

    await c.send("renameEntry", { relPath: "a.txt", newName: "b.txt" });

    expect(await fs.readFile(`${ROOT}/b.txt`, "utf8")).toBe("x");
    expect(c.roomEmits).toContainEqual({
      room: PROJECT,
      event: "renameEntrySuccess",
      payload: { relPath: "a.txt", newRelPath: "b.txt" },
    });
  });

  /** A destination name with a separator would be a traversal vector through
   *  the second argument. */
  it("refuses a rename whose new name contains a path separator", async () => {
    const c = connect();

    await c.send("renameEntry", { relPath: "a.txt", newName: "../escape" });

    expect(c.emitted).toContainEqual(
      expect.objectContaining({
        event: "error",
        payload: expect.objectContaining({ code: "INVALID_NAME" }),
      }),
    );
  });

  it("refuses to move a folder inside itself", async () => {
    await fs.mkdir(`${ROOT}/src/nested`, { recursive: true });
    const c = connect();

    await c.send("moveEntry", { relPath: "src", destDir: "src/nested" });

    expect(c.emitted).toContainEqual(
      expect.objectContaining({
        event: "error",
        payload: expect.objectContaining({ code: "INVALID_MOVE" }),
      }),
    );
  });
});

describe("editorHandler: shared documents", () => {
  it("hands a joining editor the document state and the peer count", async () => {
    const c = connect();
    c.adapterRooms.set(docRoomName(PROJECT, "a.txt"), new Set(["socket-1"]));

    await c.send("docJoin", { relPath: "a.txt" });

    expect(collab.joinDoc).toHaveBeenCalledWith(PROJECT, "a.txt", "socket-1");
    expect(c.rooms.has(docRoomName(PROJECT, "a.txt"))).toBe(true);
    expect(c.emitted).toContainEqual({
      event: "docSync",
      payload: { relPath: "a.txt", state: new Uint8Array([1, 2, 3]).buffer },
    });
    expect(c.roomEmits).toContainEqual({
      room: docRoomName(PROJECT, "a.txt"),
      event: "docPeers",
      payload: { relPath: "a.txt", count: 1 },
    });
  });

  it("ignores a save request for a document this socket has not joined", async () => {
    const c = connect();

    await c.send("docSave", { relPath: "a.txt" });

    expect(collab.flushDoc).not.toHaveBeenCalled();
    expect(c.roomEmits).toHaveLength(0);
  });

  it("flushes a joined document and tells everyone who has it open", async () => {
    const c = connect();
    const room = docRoomName(PROJECT, "a.txt");
    c.rooms.add(room);

    await c.send("docSave", { relPath: "a.txt" });

    expect(collab.flushDoc).toHaveBeenCalledWith(PROJECT, "a.txt");
    expect(c.roomEmits).toContainEqual({ room, event: "docSaved", payload: { relPath: "a.txt" } });
  });

  it("relays an accepted update to the room minus the sender", async () => {
    const c = connect();
    const room = docRoomName(PROJECT, "a.txt");
    c.rooms.add(room);
    collab.applyDocUpdate.mockReturnValue(true);

    const update = new Uint8Array([9, 9]).buffer;
    await c.send("docUpdate", { relPath: "a.txt", update });

    expect(c.toEmits).toContainEqual({ room, event: "docUpdate", payload: { relPath: "a.txt", update } });
  });

  it("drops an update the collaboration service rejected", async () => {
    const c = connect();
    c.rooms.add(docRoomName(PROJECT, "a.txt"));
    collab.applyDocUpdate.mockReturnValue(false);

    await c.send("docUpdate", { relPath: "a.txt", update: new Uint8Array([1]).buffer });

    expect(c.toEmits).toHaveLength(0);
  });

  /** Awareness relays run outside `handle`, so the room-membership and size
   *  guards are all that keeps them honest. */
  it("relays a cursor only for a joined document and only under the size cap", async () => {
    const c = connect();
    const room = docRoomName(PROJECT, "a.txt");

    await c.send("docAwareness", { relPath: "a.txt", update: new Uint8Array([1]).buffer });
    expect(c.toEmits).toHaveLength(0);

    c.rooms.add(room);
    const huge = new Uint8Array(65 * 1024).buffer;
    await c.send("docAwareness", { relPath: "a.txt", update: huge });
    expect(c.toEmits).toHaveLength(0);

    const fine = new Uint8Array([1, 2]).buffer;
    await c.send("docAwareness", { relPath: "a.txt", update: fine });
    expect(c.toEmits).toEqual([{ room, event: "docAwareness", payload: { relPath: "a.txt", update: fine } }]);
  });

  it("releases every held document when the socket vanishes", async () => {
    const c = connect();
    collab.docsForSocket.mockReturnValue([
      { projectId: PROJECT, relPath: "a.txt" },
    ]);

    await c.send("disconnect", undefined);
    await vi.waitFor(() =>
      expect(collab.leaveDoc).toHaveBeenCalledWith(PROJECT, "a.txt", "socket-1"),
    );
  });
});

describe("editorHandler: dev server", () => {
  it("replays state and history on subscribe, then reconciles and auto-starts", async () => {
    runner.getRunState.mockReturnValue("running");
    runner.getRunHistory.mockReturnValue(["log line"]);
    const c = connect();

    await c.send("runSubscribe", undefined);
    await vi.waitFor(() => expect(runner.autoStartRun).toHaveBeenCalledWith(PROJECT));

    expect(c.emitted).toContainEqual({ event: "runState", payload: "running" });
    expect(c.emitted).toContainEqual({ event: "runHistory", payload: { chunks: ["log line"] } });
    expect(runner.reconcileRun).toHaveBeenCalledWith(PROJECT);
  });

  /** A viewer must not spend the owner's container budget just by looking. */
  it("subscribes a viewer without starting anything", async () => {
    const c = connect("viewer");

    await c.send("runSubscribe", undefined);
    await new Promise((resolve) => setImmediate(resolve));

    expect(runner.reconcileRun).toHaveBeenCalled();
    expect(runner.autoStartRun).not.toHaveBeenCalled();
  });

  it("starts, stops and restarts on request from an editor", async () => {
    const c = connect();

    await c.send("runStart", undefined);
    await c.send("runStop", undefined);
    await c.send("runRestart", undefined);

    expect(runner.startRun).toHaveBeenCalledWith(PROJECT);
    expect(runner.stopRun).toHaveBeenCalledWith(PROJECT);
    expect(runner.restartRun).toHaveBeenCalledWith(PROJECT);
  });

  it("relays run events to the project room", async () => {
    // A fresh project id: the run relay is refcounted per project and lives in
    // a module-level map, so earlier tests' sockets still hold PROJECT's.
    const OTHER = "8c1f9a20-4b7d-4e3a-9c8f-1d2e3f4a5b6c";
    let relay: ((event: RunEvent) => void) | undefined;
    runner.subscribe.mockImplementation((_id, listener) => {
      relay = listener;
      return () => {};
    });

    const c = connect("editor", OTHER);
    await vi.waitFor(() => expect(relay).toBeDefined());

    relay?.({ type: "output", chunk: "hello" });
    relay?.({ type: "state", state: "running" });
    relay?.({ type: "ready", port: 3000 });

    expect(c.roomEmits).toContainEqual({ room: OTHER, event: "runOutput", payload: { chunk: "hello" } });
    expect(c.roomEmits).toContainEqual({ room: OTHER, event: "runState", payload: "running" });
    expect(c.roomEmits).toContainEqual({ room: OTHER, event: "previewReady", payload: { port: 3000 } });
  });
});

describe("editorHandler: replace", () => {
  it("rewrites the files, drops their live documents, and announces the change", async () => {
    replaceInProject.mockResolvedValue({
      files: [
        { relPath: "src/a.ts", replacements: 3 },
        { relPath: "src/b.ts", replacements: 1 },
      ],
      replacements: 4,
      truncated: false,
    });
    const c = connect();

    await c.send("replaceInProject", {
      search: { query: "oldName" },
      replacement: "newName",
    });

    expect(replaceInProject).toHaveBeenCalledWith(PROJECT, {
      search: { query: "oldName" },
      replacement: "newName",
    });
    // A shared document holds the file's pre-rewrite text in memory and would
    // write it back over the rewrite on its next flush.
    expect(collab.dropDoc).toHaveBeenCalledWith(PROJECT, "src/a.ts");
    expect(collab.dropDoc).toHaveBeenCalledWith(PROJECT, "src/b.ts");
    expect(c.emitted).toContainEqual({
      event: "replaceResult",
      payload: {
        query: "oldName",
        files: [
          { relPath: "src/a.ts", replacements: 3 },
          { relPath: "src/b.ts", replacements: 1 },
        ],
        replacements: 4,
        truncated: false,
      },
    });
    expect(c.roomEmits).toContainEqual({ room: PROJECT, event: "treeChanged", payload: undefined });
  });

  it("shares the search budget, so a loop of rewrites is cut off", async () => {
    const c = connect();

    for (let i = 0; i < 30; i += 1) {
      await c.send("search", { query: "x" });
    }
    await c.send("replaceInProject", { search: { query: "x" }, replacement: "y" });

    expect(replaceInProject).not.toHaveBeenCalled();
    expect(c.emitted).toContainEqual({
      event: "error",
      payload: expect.objectContaining({ code: "TOO_MANY_REQUESTS" }),
    });
  });
});

describe("editorHandler: budgets", () => {
  /** Search scans the tree, so it is the tightest budget on the socket. */
  it("cuts off a client that loops search past its budget", async () => {
    const c = connect();

    for (let i = 0; i < 30; i += 1) {
      await c.send("search", { query: "x" });
    }
    expect(c.emitted.every((e) => e.event === "searchResults")).toBe(true);

    await c.send("search", { query: "x" });
    expect(c.emitted).toContainEqual({
      event: "error",
      payload: expect.objectContaining({ code: "TOO_MANY_REQUESTS" }),
    });
  });
});
