/** Typed socket.io contract for the `/editor` namespace.
 *
 *  Every path is a POSIX path RELATIVE to the project root. The server resolves
 *  it against the project directory and rejects anything that escapes — see
 *  `resolveInProject`. The projectId is not part of these payloads: it is fixed
 *  at handshake time and verified against the caller's ownership, so a socket
 *  cannot reach into another project by changing a field.
 */

/** Largest file the editor will open or save.
 *
 *  Monaco is unusable past this, and it stops a stray binary or log file from
 *  pinning the server. Declared here so the client can refuse a write before
 *  sending it rather than discovering the limit from an error.
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

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

/** Moving an entry to a different folder.
 *
 *  Separate from renameEntry, which takes a bare NAME precisely so it cannot
 *  express a path. This one has to, so both ends go through the project's path
 *  confinement rather than being trusted. */
export interface MovePayload {
  relPath: string;
  /** Destination directory, relative to the project root. "" is the root. */
  destDir: string;
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

/** How a project's container is doing against its budget.
 *
 *  Without this an OOM kill looked like the dev server exiting for no reason:
 *  the limits were enforced but never surfaced, so there was nothing to see. */
export interface ContainerStats {
  running: boolean;
  /** Resident memory, and the ceiling it is measured against. */
  memoryBytes: number;
  memoryLimitBytes: number;
  /** Whole-CPU percentage; 50 means half a core. */
  cpuPercent: number;
  /** Seconds until the idle reaper stops this container, or null while
   *  something is still attached to it. */
  idleStopInSeconds: number | null;
}

/** What to look for when searching a project's files. */
export interface SearchOptions {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  /** Treat `query` as a regular expression rather than literal text. */
  isRegex?: boolean;
}

/** One line that matched. */
export interface SearchMatch {
  relPath: string;
  /** 1-based, so it can be handed to the editor directly. */
  line: number;
  column: number;
  /** The line's text, trimmed for transport. */
  preview: string;
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
  moveEntry: (payload: MovePayload) => void;
  /** Start the template's start command inside the project container. */
  runStart: () => void;
  /** Kill it. */
  runStop: () => void;
  /** Stop and start again, without the user having to do both. */
  runRestart: () => void;
  /** Ask for the current state — sent on connect, since the dev server may
   *  already be running from an earlier session. */
  runSubscribe: () => void;
  /** Ask for one container stats sample. */
  statsRequest: () => void;
  /** Search the project's file contents. */
  search: (payload: SearchOptions) => void;
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
  moveEntrySuccess: (payload: { relPath: string; newRelPath: string }) => void;
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
  /** The dev server is listening and the preview is worth (re)loading. Lets
   *  the preview pane show the app the moment it comes up, rather than
   *  leaving the user to guess when to press reload. */
  previewReady: (payload: { port: number }) => void;
  /** Container resource use, in reply to statsRequest. */
  containerStats: (payload: ContainerStats) => void;
  /** Results for the most recent `search`. `truncated` means a limit stopped
   *  the scan, so the list is partial rather than complete. */
  searchResults: (payload: {
    query: string;
    matches: SearchMatch[];
    truncated: boolean;
  }) => void;
  error: (payload: { code: string; message: string }) => void;
}

/** Data attached server-side to each socket by the handshake auth middleware,
 *  before any handler is registered. */
export interface SocketData {
  userId: string;
  projectId: string;
}
