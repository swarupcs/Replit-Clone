/** Typed socket.io contract for the `/editor` namespace.
 *
 *  NOTE (Phase 0): this mirrors the pre-existing JS wire format verbatim so the
 *  TypeScript conversion is behaviour-preserving. `pathToFileOrFolder` is a
 *  client-supplied ABSOLUTE host path, which is the path-traversal hole called
 *  out in the plan — Phase 2 replaces it with `{ projectId, relPath }`.
 */

export interface PathPayload {
  pathToFileOrFolder: string;
}

export interface WriteFilePayload extends PathPayload {
  data: string;
}

export interface GetPortPayload {
  containerName: string;
}

/** Events the browser emits to the server. */
export interface ClientToServerEvents {
  writeFile: (payload: WriteFilePayload) => void;
  createFile: (payload: PathPayload) => void;
  readFile: (payload: PathPayload) => void;
  deleteFile: (payload: PathPayload) => void;
  createFolder: (payload: PathPayload) => void;
  deleteFolder: (payload: PathPayload) => void;
  getPort: (payload: GetPortPayload) => void;
}

/** Events the server emits to the browser. */
export interface ServerToClientEvents {
  writeFileSuccess: (payload: { data: string; path: string }) => void;
  createFileSuccess: (payload: { data: string }) => void;
  readFileSuccess: (payload: { value: string; path: string }) => void;
  deleteFileSuccess: (payload: { data: string }) => void;
  createFolderSuccess: (payload: { data: string }) => void;
  deleteFolderSuccess: (payload: { data: string }) => void;
  getPortSuccess: (payload: { port: string | undefined }) => void;
  error: (payload: { data: string }) => void;
}

/** Data attached server-side to each connected socket. */
export interface SocketData {
  projectId: string;
}

/** Handshake query the client sends when opening the `/editor` namespace. */
export interface EditorHandshakeQuery {
  projectId: string;
}
