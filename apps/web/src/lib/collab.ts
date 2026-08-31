import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { MonacoBinding } from "y-monaco";
import { discardWrite } from "./pendingWrites.ts";
import {
  applyCursorStyles,
  safeColor,
  type CursorStyle,
} from "./remoteCursors.ts";
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

/** Somebody else in the project, and where they are.
 *
 *  Keyed by name, which is the account's email: awareness is per document and
 *  each document has its own client id, so the same person in two files is two
 *  client ids and must be folded back into one person.
 */
export interface Peer {
  key: string;
  name: string;
  color: string;
  /** The files they have open, which is the only place presence exists — a
   *  collaborator with no file open is in the project but not in any
   *  document, and cannot be seen from here. */
  files: string[];
}

/** Where somebody's editor is scrolled to, in line numbers.
 *
 *  Published per document, because a person in two files is scrolled to two
 *  different places and only the one in the file being followed matters. */
export interface Viewport {
  top: number;
  bottom: number;
}

interface Present {
  clientId: number;
  name: string;
  color: string;
  viewport?: Viewport;
}

/** A viewport as it arrives from another client — which is to say, unvalidated.
 *  Anything that is not a pair of finite line numbers is not a viewport. */
function readViewport(value: unknown): Viewport | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const { top, bottom } = value as { top?: unknown; bottom?: unknown };
  if (typeof top !== "number" || typeof bottom !== "number") return undefined;
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return undefined;

  return { top, bottom };
}

/** Reads one document's awareness, skipping our own entry. */
function othersIn(live: LiveDoc): Present[] {
  const found: Present[] = [];

  for (const [clientId, state] of live.awareness.getStates()) {
    if (clientId === live.awareness.clientID) continue;

    const user = (state as { user?: { name?: unknown; color?: unknown } }).user;
    if (typeof user?.name !== "string") continue;

    found.push({
      clientId,
      name: user.name,
      // Not `typeof === "string"`: this colour is interpolated into a
      // stylesheet by `remoteCursors`, and a string is not the same thing as a
      // colour. A peer whose colour does not parse gets the one derived from
      // their name, which is what they would have had anyway.
      color: safeColor(user.color, colorFor(user.name)),
      viewport: readViewport(
        (state as { viewport?: unknown }).viewport,
      ),
    });
  }

  return found;
}

/** Everyone else currently in the project, folded across documents. */
export function peers(): Peer[] {
  const byName = new Map<string, Peer>();

  for (const [relPath, live] of docs) {
    for (const person of othersIn(live)) {
      const existing = byName.get(person.name);
      if (existing) {
        if (!existing.files.includes(relPath)) existing.files.push(relPath);
        continue;
      }

      byName.set(person.name, {
        key: person.name,
        name: person.name,
        color: person.color,
        files: [relPath],
      });
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Everyone else in one file. */
export function peersIn(relPath: string): Peer[] {
  const live = docs.get(relPath);
  if (!live) return [];

  return othersIn(live).map((person) => ({
    key: person.name,
    name: person.name,
    color: person.color,
    files: [relPath],
  }));
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
  // Other people's carets are drawn by CSS whose rules name their client ids,
  // so the stylesheet has to be rebuilt whenever the set of people changes.
  // Hung off `notify` rather than off the awareness handler because a document
  // being torn down removes cursors too, and that path does not go through
  // awareness at all.
  applyCursorStyles(cursorStyles());

  for (const listener of listeners) listener();
}

/** Everyone visible right now, as the stylesheet needs them.
 *
 *  Not folded by name the way `peers` folds: the same person in two files is
 *  two client ids and each one decorates its own document, so both need a
 *  rule even though they share a name and a colour. */
function cursorStyles(): CursorStyle[] {
  const found: CursorStyle[] = [];

  for (const live of docs.values()) {
    for (const person of othersIn(live)) {
      found.push({
        clientId: person.clientId,
        name: person.name,
        color: person.color,
      });
    }
  }

  return found;
}

/** Where a named collaborator is scrolled to in one file.
 *
 *  Per file rather than per person: `peers` folds somebody in two documents
 *  into one entry, and a single scroll position for two files is meaningless.
 */
export function viewportIn(relPath: string, name: string): Viewport | undefined {
  const live = docs.get(relPath);
  if (!live) return undefined;

  return othersIn(live).find((person) => person.name === name)?.viewport;
}

/** Last viewport put on the wire, per file.
 *
 *  Scrolling fires continuously and awareness broadcasts on every local
 *  change, so publishing unconditionally would put a packet on the socket for
 *  every frame of a flick-scroll. Only a change in the visible LINES is worth
 *  telling anyone about — pixel-level movement within a line is not something
 *  a follower could act on. */
const publishedViewports = new Map<string, Viewport>();

/** Publishes this editor's visible range for anyone following. */
export function publishViewport(relPath: string, viewport: Viewport): void {
  const live = docs.get(relPath);
  if (!live) return;

  const last = publishedViewports.get(relPath);
  if (last && last.top === viewport.top && last.bottom === viewport.bottom) {
    return;
  }

  publishedViewports.set(relPath, viewport);
  live.awareness.setLocalStateField("viewport", viewport);
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
      // Who is present has changed. Only the peer COUNT used to announce
      // itself, so anything reading awareness for names and colours never
      // heard about someone arriving.
      notify();
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
  // Otherwise reopening the file starts with a "last published" that no longer
  // matches an awareness state anybody holds, and the first scroll back to
  // where you were would be suppressed as a no-op.
  publishedViewports.delete(relPath);
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
