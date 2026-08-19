/** Typed socket.io contract for the `/editor` namespace.
 *
 *  Every path is a POSIX path RELATIVE to the project root. The server resolves
 *  it against the project directory and rejects anything that escapes — see
 *  `resolveInProject`. The projectId is not part of these payloads: it is fixed
 *  at handshake time and verified against the caller's ownership, so a socket
 *  cannot reach into another project by changing a field.
 */

export interface PathPayload {
  relPath: string;
}

export interface WriteFilePayload extends PathPayload {
  data: string;
}

export interface RenamePayload {
  relPath: string;
  newName: string;
}

/** Events the browser emits to the server. */
export interface ClientToServerEvents {
  readFile: (payload: PathPayload) => void;
  writeFile: (payload: WriteFilePayload) => void;
  createFile: (payload: PathPayload) => void;
  deleteFile: (payload: PathPayload) => void;
  createFolder: (payload: PathPayload) => void;
  deleteFolder: (payload: PathPayload) => void;
  renameEntry: (payload: RenamePayload) => void;
}

/** Events the server emits to the browser. */
export interface ServerToClientEvents {
  readFileSuccess: (payload: { relPath: string; value: string }) => void;
  writeFileSuccess: (payload: { relPath: string }) => void;
  createFileSuccess: (payload: { relPath: string }) => void;
  deleteFileSuccess: (payload: { relPath: string }) => void;
  createFolderSuccess: (payload: { relPath: string }) => void;
  deleteFolderSuccess: (payload: { relPath: string }) => void;
  renameEntrySuccess: (payload: { relPath: string; newRelPath: string }) => void;
  /** The project's files changed on disk; the client should refetch the tree. */
  treeChanged: () => void;
  error: (payload: { code: string; message: string }) => void;
}

/** Data attached server-side to each socket by the handshake auth middleware,
 *  before any handler is registered. */
export interface SocketData {
  userId: string;
  projectId: string;
}
