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

/** Lifecycle of the project's dev server, as driven by the Run button.
 *
 *  - `idle`      nothing has been started
 *  - `starting`  the start command is running but nothing is listening yet
 *                (this covers `npm install`, which can take a while)
 *  - `running`   the dev server is accepting connections on its template port
 *  - `exited`    the command finished or crashed; see `exitCode`
 */
export type RunStatus = "idle" | "starting" | "running" | "exited";

export interface RunState {
  status: RunStatus;
  /** Present only for `exited`. */
  exitCode?: number;
  /** The command being run, so the UI can show what it is doing. */
  command?: string;
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
  /** Start the template's start command inside the project container. */
  runStart: () => void;
  /** Kill it. */
  runStop: () => void;
  /** Ask for the current state — sent on connect, since the dev server may
   *  already be running from an earlier session. */
  runSubscribe: () => void;
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
  /** Dev server lifecycle changed. Broadcast to the whole project room so
   *  every open tab agrees on the state. */
  runState: (payload: RunState) => void;
  /** A chunk of the start command's combined stdout/stderr. */
  runOutput: (payload: { chunk: string }) => void;
  /** Sent on subscribe so a reconnecting client can rebuild the log pane
   *  instead of showing an empty one under a "running" badge. */
  runHistory: (payload: { chunks: string[] }) => void;
  error: (payload: { code: string; message: string }) => void;
}

/** Data attached server-side to each socket by the handshake auth middleware,
 *  before any handler is registered. */
export interface SocketData {
  userId: string;
  projectId: string;
}
