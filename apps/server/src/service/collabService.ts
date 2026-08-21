import fs from "node:fs/promises";
import * as Y from "yjs";
import { MAX_FILE_BYTES } from "@replit-clone/shared";
import { logger } from "../lib/logger.js";
import { resolveInProject } from "../utils/projectPaths.js";
import { assertWithinQuota, recordWrite } from "./diskUsageService.js";
import { assertUserDiskQuota } from "./userQuotaService.js";

/** Shared editing, one CRDT document per open file.
 *
 *  Two people editing one file previously meant last-write-wins over a
 *  debounced save: whoever stopped typing last silently overwrote the other.
 *  A CRDT merges concurrent edits instead, so neither has to lose.
 *
 *  The design decision that makes this safe is that **the server owns
 *  persistence**. While a document is live it is the truth and the client
 *  stops writing files itself; the server flushes it to disk. One writer, not
 *  two racing each other.
 */

/** Name of the shared text inside each document. Both ends must agree. */
export const CONTENT_KEY = "content";

/** How long after the last change to write to disk. Long enough that a burst
 *  of typing is one write, short enough that a crash loses little. */
const FLUSH_DEBOUNCE_MS = 1500;

/** Upper bound on how long changes can go unwritten under continuous typing,
 *  which would otherwise keep resetting the debounce forever. */
const FLUSH_MAX_WAIT_MS = 10_000;

interface LiveDoc {
  doc: Y.Doc;
  /** Sockets currently editing this file. */
  subscribers: Set<string>;
  flushTimer?: NodeJS.Timeout;
  /** When the current unflushed run of changes began. */
  dirtySince?: number;
  /** Contents as last written by us, so a change made outside the editor can
   *  be told apart from our own write coming back through the watcher. */
  lastWritten: string;
}

/** Keyed by project and path: two projects may have the same file name, and
 *  they are entirely separate documents. */
const docs = new Map<string, LiveDoc>();

/** Told whenever a document reaches disk.
 *
 *  This service knows nothing about sockets, and a flush happens on a timer
 *  rather than in reply to a request, so there is nobody to answer. Without a
 *  hook here the clients were never told their work had been saved: the
 *  editor clears a tab's unsaved marker on `writeFileSuccess`, which the
 *  server stops sending the moment a file is shared. Registered once, in
 *  index.ts, where the namespace lives.
 */
type SaveListener = (projectId: string, relPath: string) => void;

let onSaved: SaveListener | null = null;

export function setDocSaveListener(listener: SaveListener | null): void {
  onSaved = listener;
}

/** Joins the two halves of a document key.
 *
 *  A NUL cannot appear in a path, so the split is never ambiguous. Written as
 *  an escape rather than embedded as a raw byte: the raw version made this
 *  file binary to `grep -r`, so a codebase-wide search skipped it entirely —
 *  which is how `liveDocPaths` came to build the same prefix with a SPACE and
 *  silently match nothing, taking external-change reporting with it.
 */
const KEY_SEPARATOR = "\0";

function key(projectId: string, relPath: string): string {
  return `${projectId}${KEY_SEPARATOR}${relPath}`;
}

export interface DocHandle {
  doc: Y.Doc;
  /** The document's full state, for a client that has just joined. */
  state: Uint8Array;
}

/** Joins a file's document, loading it from disk if nobody has it open.
 *
 *  Returns the state a newcomer needs to catch up. Yjs merges by construction,
 *  so a client that already has local changes converges rather than clobbering.
 */
export async function joinDoc(
  projectId: string,
  relPath: string,
  socketId: string,
): Promise<DocHandle> {
  const id = key(projectId, relPath);
  const existing = docs.get(id);

  if (existing) {
    existing.subscribers.add(socketId);
    return { doc: existing.doc, state: Y.encodeStateAsUpdate(existing.doc) };
  }

  const absolute = resolveInProject(projectId, relPath);
  const contents = await fs.readFile(absolute, "utf8");

  const doc = new Y.Doc();
  // Seeded in a transaction with a null origin, so this initial fill is not
  // mistaken for a user edit and echoed back to whoever opened the file.
  doc.transact(() => {
    doc.getText(CONTENT_KEY).insert(0, contents);
  }, "load");

  const live: LiveDoc = {
    doc,
    subscribers: new Set([socketId]),
    lastWritten: contents,
  };
  docs.set(id, live);

  return { doc, state: Y.encodeStateAsUpdate(doc) };
}

/** Applies an update from a client. Returns false when nobody has this file
 *  open, which means the update arrived after everyone left. */
export function applyDocUpdate(
  projectId: string,
  relPath: string,
  update: Uint8Array,
  origin: string,
): boolean {
  const live = docs.get(key(projectId, relPath));
  if (!live) return false;

  Y.applyUpdate(live.doc, update, origin);
  scheduleFlush(projectId, relPath, live);

  return true;
}

function scheduleFlush(
  projectId: string,
  relPath: string,
  live: LiveDoc,
): void {
  live.dirtySince ??= Date.now();

  // Continuous typing would otherwise reset the debounce indefinitely and
  // never write anything at all.
  if (Date.now() - live.dirtySince >= FLUSH_MAX_WAIT_MS) {
    void flushDoc(projectId, relPath);
    return;
  }

  if (live.flushTimer) clearTimeout(live.flushTimer);
  live.flushTimer = setTimeout(() => {
    void flushDoc(projectId, relPath);
  }, FLUSH_DEBOUNCE_MS);
}

/** Writes a document to disk. */
export async function flushDoc(projectId: string, relPath: string): Promise<void> {
  const live = docs.get(key(projectId, relPath));
  if (!live) return;

  if (live.flushTimer) clearTimeout(live.flushTimer);
  live.flushTimer = undefined;
  live.dirtySince = undefined;

  const contents = live.doc.getText(CONTENT_KEY).toJSON();
  if (contents === live.lastWritten) return;

  const absolute = resolveInProject(projectId, relPath);
  const incoming = Buffer.byteLength(contents, "utf8");

  // A document outlives the file for as long as it takes the delete to reach
  // here, and `writeFile` would happily bring it back. Deleting a file with
  // unflushed edits used to do exactly that: the file returned moments later
  // holding whatever had been typed into it.
  const stillThere = await fs
    .stat(absolute)
    .then(() => true)
    .catch(() => false);

  if (!stillThere) {
    logger.info("dropping a document whose file is gone", { projectId, relPath });
    dropDoc(projectId, relPath);
    return;
  }

  if (incoming > MAX_FILE_BYTES) {
    logger.warn("collaborative document is too large to save", { projectId, relPath });
    return;
  }

  try {
    const existing = await fs.stat(absolute).catch(() => undefined);
    await assertWithinQuota(projectId, incoming, existing?.size ?? 0);
    await assertUserDiskQuota(projectId, incoming, existing?.size ?? 0);

    await fs.writeFile(absolute, contents, "utf8");
    recordWrite(projectId, incoming, existing?.size ?? 0);
    live.lastWritten = contents;

    // Only after the write actually succeeded: telling the editor a file is
    // saved when it is not is worse than not telling it at all.
    onSaved?.(projectId, relPath);
  } catch (error) {
    // The document keeps the changes, so the next flush tries again. Losing
    // them here because the disk was momentarily full would be far worse.
    logger.error("could not flush collaborative document", error, {
      projectId,
      relPath,
    });
  }
}

/** Leaves a document, writing it out when the last editor goes.
 *
 *  Dropping it is what makes the next reader load from disk again, so a file
 *  edited in a terminal after everyone closed it is not served stale.
 */
export async function leaveDoc(
  projectId: string,
  relPath: string,
  socketId: string,
): Promise<void> {
  const id = key(projectId, relPath);
  const live = docs.get(id);
  if (!live) return;

  live.subscribers.delete(socketId);
  if (live.subscribers.size > 0) return;

  await flushDoc(projectId, relPath);

  live.doc.destroy();
  docs.delete(id);
}

/** Every document a socket had open. Used to clean up on disconnect. */
export function docsForSocket(socketId: string): { projectId: string; relPath: string }[] {
  const found: { projectId: string; relPath: string }[] = [];

  for (const [id, live] of docs) {
    if (!live.subscribers.has(socketId)) continue;

    const [projectId, relPath] = id.split(KEY_SEPARATOR);
    if (projectId && relPath !== undefined) found.push({ projectId, relPath });
  }

  return found;
}

/** Files in this project that someone currently has open. */
export function liveDocPaths(projectId: string): string[] {
  const prefix = `${projectId}${KEY_SEPARATOR}`;
  const found: string[] = [];

  for (const id of docs.keys()) {
    if (id.startsWith(prefix)) found.push(id.slice(prefix.length));
  }

  return found;
}

/** Whether a file is being edited collaboratively right now. */
export function isLive(projectId: string, relPath: string): boolean {
  return docs.has(key(projectId, relPath));
}

/** Reconciles a change made outside the editor — a terminal command, a build
 *  step — with a document that is currently open.
 *
 *  The honest answer here is that there is no way to merge an opaque external
 *  rewrite into a CRDT: the external writer produced whole new contents with no
 *  record of which edits made them. Rather than guess, this reports the
 *  conflict and leaves the document alone, so nobody's in-progress work
 *  disappears under them. Whoever is editing decides what to do.
 */
export async function detectExternalChange(
  projectId: string,
  relPath: string,
): Promise<boolean> {
  const live = docs.get(key(projectId, relPath));
  if (!live) return false;

  const absolute = resolveInProject(projectId, relPath);
  const onDisk = await fs.readFile(absolute, "utf8").catch(() => undefined);

  if (onDisk === undefined) return false;

  // Ours coming back through the watcher, or genuinely unchanged.
  if (onDisk === live.lastWritten) return false;

  // The document already holds these contents — someone else's client flushed
  // them, or the change matches what we have.
  return onDisk !== live.doc.getText(CONTENT_KEY).toJSON();
}

/** Discards a document without writing it.
 *
 *  For a file that is being deleted: flushing would put it straight back.
 */
export function dropDoc(projectId: string, relPath: string): void {
  const id = key(projectId, relPath);
  const live = docs.get(id);
  if (!live) return;

  if (live.flushTimer) clearTimeout(live.flushTimer);
  live.doc.destroy();
  docs.delete(id);
}

/** Discards every document inside a directory, for a folder being removed. */
export function dropDocsUnder(projectId: string, dirRelPath: string): void {
  const prefix = dirRelPath === "" ? "" : `${dirRelPath}/`;

  for (const relPath of liveDocPaths(projectId)) {
    if (prefix !== "" && !relPath.startsWith(prefix)) continue;
    dropDoc(projectId, relPath);
  }
}

/** Writes a document out and then discards it.
 *
 *  For a file about to be renamed or moved: flushing first means edits made in
 *  the last second travel with it, and discarding after means the document
 *  cannot later write itself back to the name the file no longer has. The
 *  clients rejoin under the new path on their own, since their tab moved.
 */
export async function flushAndDropDoc(
  projectId: string,
  relPath: string,
): Promise<void> {
  if (!docs.has(key(projectId, relPath))) return;

  await flushDoc(projectId, relPath);
  dropDoc(projectId, relPath);
}

/** Writes out every document that has unsaved changes.
 *
 *  For shutdown. `io.close()` fires each socket's disconnect handler, whose
 *  `leaveDoc` is not awaited by anything, and the process exited a couple of
 *  lines later — so every deploy dropped up to the debounce window of
 *  collaborative typing. The server owns saving these files, so there is no
 *  client-side copy to fall back on.
 */
export async function flushAllDocs(): Promise<void> {
  const pending = [...docs.keys()].map((id) => {
    const [projectId, relPath] = id.split(KEY_SEPARATOR);
    return { projectId, relPath };
  });

  // In parallel and individually guarded: one project's failure must not stop
  // the rest from reaching disk during the little time a shutdown has.
  await Promise.all(
    pending.map(({ projectId, relPath }) =>
      projectId !== undefined && relPath !== undefined
        ? flushDoc(projectId, relPath).catch((error: unknown) => {
            logger.error("could not flush on shutdown", error, { projectId, relPath });
          })
        : Promise.resolve(),
    ),
  );
}

/** Drops every document for a project, e.g. when it is deleted. */
export function forgetProject(projectId: string): void {
  for (const [id, live] of docs) {
    if (!id.startsWith(`${projectId}${KEY_SEPARATOR}`)) continue;

    if (live.flushTimer) clearTimeout(live.flushTimer);
    live.doc.destroy();
    docs.delete(id);
  }
}

/** Only for tests, which need a clean slate between cases. */
export function resetCollabState(): void {
  for (const live of docs.values()) {
    if (live.flushTimer) clearTimeout(live.flushTimer);
    live.doc.destroy();
  }
  docs.clear();
}
