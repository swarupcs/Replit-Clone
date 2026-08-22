import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { MonacoBinding } from "y-monaco";
import { discardWrite } from "./pendingWrites.ts";
import type { editor } from "monaco-editor";
import type { EditorSocket } from "../store/editorSocketStore.ts";

/** Shared editing on the client.
 *
 *  One Yjs document per open file, relayed over the editor socket rather than
 *  a second WebSocket — that keeps one connection, one auth surface, and one
 *  place where a reconnect is handled.
 *
 *  The server owns writing the file while a document is live, so the editor's
 *  own debounced `writeFile` is suppressed for these paths. One writer, not
 *  two racing.
 */

/** Text inside each document. Must match the server's CONTENT_KEY. */
const CONTENT_KEY = "content";

interface LiveDoc {
  doc: Y.Doc;
  text: Y.Text;
  awareness: Awareness;
  binding?: MonacoBinding;
  /** A bind asked for before the server's state arrived, held until it does.
   *  See `bindDoc`. */
  pendingBind?: { model: editor.ITextModel; codeEditor: editor.IStandaloneCodeEditor };
  /** Panes currently showing this file. The document outlives any one of
   *  them, so it is torn down on the last release rather than the first. */
  refCount: number;
  /** Whether the server's initial state has arrived. Until it has, the local
   *  document is empty and must not be written to the model. */
  synced: boolean;
  peers: number;
}

const docs = new Map<string, LiveDoc>();

/** Paths currently edited collaboratively, so the editor knows to leave
 *  persistence to the server. */
export function isCollaborative(relPath: string): boolean {
  return docs.get(relPath)?.synced ?? false;
}

export function peerCount(relPath: string): number {
  return docs.get(relPath)?.peers ?? 0;
}

type Listener = () => void;
const listeners = new Set<Listener>();

/** Notified when a document syncs or its peer count changes, so the UI can
 *  re-render without polling. */
export function subscribeCollab(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Wires the socket's collaboration events into the local documents.
 *
 *  Installed once per socket. Returns a teardown that also drops every
 *  document, because they belong to that connection.
 */
export function installCollab(socket: EditorSocket): () => void {
  const onSync = ({ relPath, state }: { relPath: string; state: ArrayBuffer }) => {
    const live = docs.get(relPath);
    if (!live) return;

    // Applied with a distinct origin so the binding does not send it straight
    // back to the server as though it were a local edit.
    Y.applyUpdate(live.doc, new Uint8Array(state), "server");
    live.synced = true;

    // Now that the text is the file's, a binding held back by `bindDoc` can
    // safely take it to the model.
    attachPendingBind(live);

    // From here the SERVER writes this file, so any client write still on the
    // clock for it is both superseded and older than the document. Left in the
    // queue it would be flushed later — by Ctrl+S, by a blur, by switching
    // tabs — and would put that older buffer back on disk over everyone's
    // merged work. Dropping it is what keeps `flushAllWrites` safe: once this
    // has run, no queued path can be a shared one.
    discardWrite(relPath);
    notify();
  };

  const onUpdate = ({ relPath, update }: { relPath: string; update: ArrayBuffer }) => {
    const live = docs.get(relPath);
    if (!live) return;

    Y.applyUpdate(live.doc, new Uint8Array(update), "server");
  };

  const onAwareness = ({ relPath, update }: { relPath: string; update: ArrayBuffer }) => {
    const live = docs.get(relPath);
    if (!live) return;

    void import("y-protocols/awareness").then(({ applyAwarenessUpdate }) => {
      applyAwarenessUpdate(live.awareness, new Uint8Array(update), "server");
    });
  };

  const onPeers = ({ relPath, count }: { relPath: string; count: number }) => {
    const live = docs.get(relPath);
    if (!live) return;

    live.peers = count;
    notify();
  };

  socket.on("docSync", onSync);
  socket.on("docUpdate", onUpdate);
  socket.on("docAwareness", onAwareness);
  socket.on("docPeers", onPeers);

  return () => {
    socket.off("docSync", onSync);
    socket.off("docUpdate", onUpdate);
    socket.off("docAwareness", onAwareness);
    socket.off("docPeers", onPeers);

    for (const [relPath] of docs) releaseAll(relPath);
  };
}

/** Joins a file's document, or takes another reference to it. */
export function retainDoc(
  socket: EditorSocket,
  relPath: string,
  identity: { name: string; color: string },
): LiveDoc {
  const existing = docs.get(relPath);
  if (existing) {
    existing.refCount += 1;
    return existing;
  }

  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalStateField("user", identity);

  const live: LiveDoc = {
    doc,
    text: doc.getText(CONTENT_KEY),
    awareness,
    refCount: 1,
    synced: false,
    peers: 1,
  };
  docs.set(relPath, live);

  // Local changes go to the server; anything applied with the "server" origin
  // came from there and must not be echoed back.
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "server") return;
    socket.emit("docUpdate", { relPath, update: toArrayBuffer(update) });
  });

  awareness.on("update", ({ added, updated, removed }: {
    added: number[];
    updated: number[];
    removed: number[];
  }) => {
    void import("y-protocols/awareness").then(({ encodeAwarenessUpdate }) => {
      const changed = [...added, ...updated, ...removed];
      socket.emit("docAwareness", {
        relPath,
        update: toArrayBuffer(encodeAwarenessUpdate(awareness, changed)),
      });
    });
  });

  socket.emit("docJoin", { relPath });

  return live;
}

/** Attaches a binding that was waiting for the document to sync. */
function attachPendingBind(live: LiveDoc): void {
  const pending = live.pendingBind;
  if (!pending || live.binding) return;

  live.pendingBind = undefined;
  live.binding = new MonacoBinding(
    live.text,
    pending.model,
    new Set([pending.codeEditor]),
    live.awareness,
  );
}

/** Binds a document to a Monaco model.
 *
 *  Bound once per file even when two panes show it: they share one Monaco
 *  model, so a single binding keeps both in step and a second would apply
 *  every change twice.
 *
 *  Held back until the server's state has arrived. `MonacoBinding`'s
 *  constructor ends by pushing the Y.Text into the model, and `retainDoc` has
 *  only just emitted `docJoin` — so binding straight away wrote an EMPTY
 *  document over the contents the model was created with, and every file
 *  opened blank until `docSync` landed a moment later and filled it back in.
 *
 *  If the sync never comes the binding simply never attaches, and the file
 *  keeps showing what was read from disk without shared editing. That is the
 *  right way round: an un-collaborative file beats an empty one.
 */
export function bindDoc(
  relPath: string,
  model: editor.ITextModel,
  codeEditor: editor.IStandaloneCodeEditor,
): void {
  const live = docs.get(relPath);
  if (!live || live.binding) return;

  live.pendingBind = { model, codeEditor };
  if (live.synced) attachPendingBind(live);
}

/** Asks the server to write a shared document to disk now.
 *
 *  The server owns the file while it is shared and writes it on a debounce
 *  after the last change; this is how Ctrl+S reaches that instead of waiting
 *  it out. Returns false when the path is not (yet) shared, so the caller can
 *  fall back to writing it the ordinary way.
 */
export function saveDoc(socket: EditorSocket | null, relPath: string): boolean {
  if (!socket || !isCollaborative(relPath)) return false;

  socket.emit("docSave", { relPath });
  return true;
}

/** Releases one reference, tearing the document down on the last. */
export function releaseDoc(socket: EditorSocket | null, relPath: string): void {
  const live = docs.get(relPath);
  if (!live) return;

  live.refCount -= 1;
  if (live.refCount > 0) return;

  socket?.emit("docLeave", { relPath });
  destroy(relPath, live);
}

function releaseAll(relPath: string): void {
  const live = docs.get(relPath);
  if (live) destroy(relPath, live);
}

function destroy(relPath: string, live: LiveDoc): void {
  // Dropped as well as the binding: a document torn down before it synced
  // still holds a model and an editor here, and a later sync must not revive
  // a binding onto a pane that has moved on.
  live.pendingBind = undefined;
  live.binding?.destroy();
  live.awareness.destroy();
  live.doc.destroy();
  docs.delete(relPath);
  notify();
}

/** socket.io wants transferable bytes, and a Uint8Array view may be a slice of
 *  a larger buffer — sending that would send the whole thing. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/** A stable colour per person, so the same collaborator keeps one cursor
 *  colour rather than changing on every reconnect. */
export function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }

  const hues = [265, 200, 150, 35, 340, 175];
  return `hsl(${String(hues[Math.abs(hash) % hues.length] ?? 265)} 70% 62%)`;
}
