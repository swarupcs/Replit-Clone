import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What `MonacoBinding` was constructed with, and what the model held at that
 *  moment.
 *
 *  The real binding's constructor ends with `model.setValue(ytext.toString())`,
 *  which is the whole hazard here — so the stub does the same thing. A stub
 *  that only recorded the call would pass whether or not the bug was fixed.
 */
const bindings: { textAtBind: string }[] = [];

vi.mock("y-monaco", () => ({
  MonacoBinding: class {
    constructor(
      ytext: { toString: () => string },
      model: { setValue: (value: string) => void },
    ) {
      const value = ytext.toString();
      bindings.push({ textAtBind: value });
      model.setValue(value);
    }
    destroy() {
      // Nothing to unwind in the stub.
    }
  },
}));

import {
  bindDoc,
  installCollab,
  isCollaborative,
  peers,
  peersIn,
  releaseDoc,
  retainDoc,
  saveDoc,
  subscribeCollab,
} from "./collab.ts";
import {
  pendingPaths,
  queueWrite,
  resetPendingWrites,
  setWriteEmitter,
} from "./pendingWrites.ts";
import type { EditorSocket } from "../store/editorSocketStore.ts";

const PATH = "src/App.jsx";
const FILE = "export default function App() {\n  return <h1>hi</h1>;\n}\n";
const IDENTITY = { name: "someone@example.com", color: "hsl(265 70% 62%)" };

/** A socket that records emits and lets a test deliver server events. */
function fakeSocket() {
  const handlers = new Map<string, ((payload: never) => void)[]>();
  const emitted: { event: string; payload: unknown }[] = [];

  const socket = {
    on(event: string, handler: (payload: never) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return socket;
    },
    off(event: string, handler: (payload: never) => void) {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((entry) => entry !== handler),
      );
      return socket;
    },
    emit(event: string, payload: unknown) {
      emitted.push({ event, payload });
      return true;
    },
  };

  return {
    socket: socket as unknown as EditorSocket,
    emitted,
    deliver(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) {
        (handler as (value: unknown) => void)(payload);
      }
    },
  };
}

/** The state the server sends on docJoin: the file, already in the document. */
function serverState(contents: string): ArrayBuffer {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, contents);
  const update = Y.encodeStateAsUpdate(doc);
  return update.buffer.slice(
    update.byteOffset,
    update.byteOffset + update.byteLength,
  ) as ArrayBuffer;
}

/** Stands in for the Monaco model the editor created from the file it read. */
function fakeModel(initial: string) {
  return {
    value: initial,
    setValue(next: string) {
      this.value = next;
    },
  };
}

const fakeEditor = {} as never;

let harness: ReturnType<typeof fakeSocket>;
let teardown: () => void;

beforeEach(() => {
  bindings.length = 0;
  resetPendingWrites();
  harness = fakeSocket();
  teardown = installCollab(harness.socket);
});

// `docs` is module state that outlives a case, and installCollab's teardown is
// what drops it. Without this, a document retained by one test is still open
// in the next and every assertion about a fresh file is meaningless.
afterEach(() => {
  teardown();
});

describe("binding a shared document to the editor", () => {
  /** The bug: every file opened blank for a moment.
   *
   *  `retainDoc` emits docJoin and returns immediately, so at the point the
   *  editor binds, the local document is still empty. The binding's
   *  constructor writes the document into the model — so binding straight away
   *  wrote "" over the contents the model had just been created with, and the
   *  file only came back when docSync landed a moment later.
   */
  it("does not blank the model while the document is still empty", () => {
    const model = fakeModel(FILE);

    retainDoc(harness.socket, PATH, IDENTITY);
    bindDoc(PATH, model as never, fakeEditor);

    expect(bindings).toHaveLength(0);
    expect(model.value).toBe(FILE);
  });

  it("binds once the server's state arrives, with the file in hand", () => {
    const model = fakeModel(FILE);

    retainDoc(harness.socket, PATH, IDENTITY);
    bindDoc(PATH, model as never, fakeEditor);
    harness.deliver("docSync", { relPath: PATH, state: serverState(FILE) });

    expect(bindings).toHaveLength(1);
    // The decisive assertion: the document was NOT empty at bind time.
    expect(bindings[0]?.textAtBind).toBe(FILE);
    expect(model.value).toBe(FILE);
  });

  it("binds immediately when the document has already synced", () => {
    // The second pane to show a file, or a file reopened in one session.
    retainDoc(harness.socket, PATH, IDENTITY);
    harness.deliver("docSync", { relPath: PATH, state: serverState(FILE) });

    const model = fakeModel(FILE);
    bindDoc(PATH, model as never, fakeEditor);

    expect(bindings).toHaveLength(1);
    expect(model.value).toBe(FILE);
  });

  it("binds only once when two panes show the same file", () => {
    const model = fakeModel(FILE);

    retainDoc(harness.socket, PATH, IDENTITY);
    retainDoc(harness.socket, PATH, IDENTITY);
    bindDoc(PATH, model as never, fakeEditor);
    bindDoc(PATH, model as never, fakeEditor);
    harness.deliver("docSync", { relPath: PATH, state: serverState(FILE) });

    expect(bindings).toHaveLength(1);
  });

  it("reports the file as shared only once it has synced", () => {
    retainDoc(harness.socket, PATH, IDENTITY);
    expect(isCollaborative(PATH)).toBe(false);

    harness.deliver("docSync", { relPath: PATH, state: serverState(FILE) });
    expect(isCollaborative(PATH)).toBe(true);
  });

  /** A sync that never comes must leave the file readable, not empty. */
  it("leaves the model alone when the document never syncs", () => {
    const model = fakeModel(FILE);

    retainDoc(harness.socket, PATH, IDENTITY);
    bindDoc(PATH, model as never, fakeEditor);

    expect(model.value).toBe(FILE);
    expect(isCollaborative(PATH)).toBe(false);
  });

  it("does not bind after the pane has moved on", () => {
    const model = fakeModel(FILE);

    retainDoc(harness.socket, PATH, IDENTITY);
    bindDoc(PATH, model as never, fakeEditor);
    // The tab closes before the server answers.
    releaseDoc(harness.socket, PATH);

    harness.deliver("docSync", { relPath: PATH, state: serverState(FILE) });

    expect(bindings).toHaveLength(0);
    expect(model.value).toBe(FILE);
  });

  it("stops listening once the socket is torn down", () => {
    const model = fakeModel(FILE);

    retainDoc(harness.socket, PATH, IDENTITY);
    bindDoc(PATH, model as never, fakeEditor);
    teardown();

    harness.deliver("docSync", { relPath: PATH, state: serverState(FILE) });

    expect(bindings).toHaveLength(0);
  });
});

/** Saving a file that is edited together.
 *
 *  The server owns writing a shared file, from the merged document, on a
 *  debounce after the last change. Ctrl+S had no way to reach that: it fell
 *  through to the ordinary client write path, where queueing is suppressed for
 *  shared files — so it flushed whatever was still in the queue instead. That
 *  was an older buffer, queued before the document synced, and saving put
 *  those PREVIOUS contents back on disk over the edit being saved.
 */
describe("saving a shared document", () => {
  it("asks the server to write it, rather than writing it from here", () => {
    retainDoc(harness.socket, PATH, IDENTITY);
    harness.deliver("docSync", { relPath: PATH, state: serverState(FILE) });

    expect(saveDoc(harness.socket, PATH)).toBe(true);
    expect(harness.emitted.at(-1)).toEqual({
      event: "docSave",
      payload: { relPath: PATH },
    });
  });

  it("declines a file that is not shared, so the caller writes it normally", () => {
    retainDoc(harness.socket, PATH, IDENTITY);
    // No docSync yet.
    expect(saveDoc(harness.socket, PATH)).toBe(false);
    expect(saveDoc(harness.socket, "never/opened.ts")).toBe(false);
  });

  it("declines when there is no socket to ask", () => {
    retainDoc(harness.socket, PATH, IDENTITY);
    harness.deliver("docSync", { relPath: PATH, state: serverState(FILE) });

    expect(saveDoc(null, PATH)).toBe(false);
  });

  /** The write that produced the reported bug. */
  it("drops a client write queued before the document synced", () => {
    const sent: { relPath: string; data: string }[] = [];
    setWriteEmitter((relPath, data) => sent.push({ relPath, data }));

    retainDoc(harness.socket, PATH, IDENTITY);
    // Typed in the moment before the server answered, so this path was not yet
    // shared and the write was allowed to queue.
    queueWrite(PATH, "stale contents", 5_000);
    expect(pendingPaths()).toContain(PATH);

    harness.deliver("docSync", { relPath: PATH, state: serverState(FILE) });

    // Gone, and never sent: from here the server writes this file, and
    // flushing that buffer later would put it back over everyone's work.
    expect(pendingPaths()).not.toContain(PATH);
    expect(sent).toEqual([]);
  });

  it("leaves other files' queued writes alone", () => {
    setWriteEmitter(() => undefined);
    queueWrite("other/file.ts", "still wanted", 5_000);

    retainDoc(harness.socket, PATH, IDENTITY);
    harness.deliver("docSync", { relPath: PATH, state: serverState(FILE) });

    expect(pendingPaths()).toContain("other/file.ts");
  });
});


/** Presence was crossing the wire the whole time and had nowhere to go: the
 *  only place a collaborator was ever visible was the Share dialog's member
 *  list. These cover the reading of it. */
describe("who else is here", () => {
  /** Delivers another person's awareness for a file, the way the server does.
   *
   *  A real `Awareness` over its own `Y.Doc`, so it carries a client id of its
   *  own — which is the whole reason the same person in two files has to be
   *  folded back into one. */
  async function joins(relPath: string, name: string, color: string) {
    const { Awareness, encodeAwarenessUpdate } = await import(
      "y-protocols/awareness"
    );

    const theirs = new Awareness(new Y.Doc());
    theirs.setLocalStateField("user", { name, color });

    const update = encodeAwarenessUpdate(theirs, [theirs.clientID]);
    harness.deliver("docAwareness", {
      relPath,
      update: update.buffer.slice(
        update.byteOffset,
        update.byteOffset + update.byteLength,
      ),
    });

    // The module imports the awareness codec dynamically, so the update is
    // applied a turn or more later. Waited on by its effect rather than by a
    // sleep: a fixed delay is long enough until the machine is busy, and then
    // it is not.
    await vi.waitFor(() => {
      expect(peersIn(relPath).some((peer) => peer.name === name)).toBe(true);
    });
  }

  it("reports nobody while we are alone in a file", () => {
    retainDoc(harness.socket, PATH, IDENTITY);

    // Our own entry is in the awareness map and must never be counted: the
    // point of the stack is who ELSE is here.
    expect(peers()).toEqual([]);
    expect(peersIn(PATH)).toEqual([]);
  });

  it("reports someone who has the file open", async () => {
    retainDoc(harness.socket, PATH, IDENTITY);
    await joins(PATH, "ana@example.com", "hsl(200 70% 62%)");

    expect(peers()).toEqual([
      {
        key: "ana@example.com",
        name: "ana@example.com",
        color: "hsl(200 70% 62%)",
        files: [PATH],
      },
    ]);
  });

  it("folds one person across the files they have open", async () => {
    retainDoc(harness.socket, PATH, IDENTITY);
    retainDoc(harness.socket, "src/api.ts", IDENTITY);

    await joins(PATH, "ana@example.com", "hsl(200 70% 62%)");
    await joins("src/api.ts", "ana@example.com", "hsl(200 70% 62%)");

    // Two documents, two client ids, one person.
    const found = peers();
    expect(found).toHaveLength(1);
    expect(found[0]?.files.sort()).toEqual(["src/api.ts", PATH].sort());
  });

  it("answers for one file on its own", async () => {
    retainDoc(harness.socket, PATH, IDENTITY);
    retainDoc(harness.socket, "src/api.ts", IDENTITY);
    await joins(PATH, "ana@example.com", "hsl(200 70% 62%)");

    expect(peersIn(PATH).map((peer) => peer.name)).toEqual([
      "ana@example.com",
    ]);
    expect(peersIn("src/api.ts")).toEqual([]);
  });

  it("announces an arrival, not only a change of count", async () => {
    // Only the peer COUNT used to notify, so anything reading awareness for
    // names and colours never heard about someone arriving.
    const heard = vi.fn();
    retainDoc(harness.socket, PATH, IDENTITY);
    const stop = subscribeCollab(heard);

    await joins(PATH, "ana@example.com", "hsl(200 70% 62%)");
    stop();

    expect(heard).toHaveBeenCalled();
  });
});
