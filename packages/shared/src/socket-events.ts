import type {
  AiActivity,
  AiAskPayload,
  AiProposal,
  AiStopReason,
} from "./ai.js";

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

/** What one project contributed to a search that spanned several.
 *
 *  The project is named as well as identified because this is the only search
 *  whose results the user cannot place from the path alone -- "src/index.ts"
 *  is in most of their projects. */
export interface ProjectSearchHit {
  projectId: string;
  name: string;
  matches: SearchMatch[];
  /** True when this project's own limits stopped its scan. */
  truncated: boolean;
}

/** Searching every project the user owns.
 *
 *  Deliberately not the same shape as a single project's result. A flat list
 *  of matches would lose which project each came from, and that is the only
 *  question this search exists to answer -- "which project did I write that
 *  in" is not a question anybody asks about a project they already have open.
 */
export interface CrossProjectSearchResult {
  projects: ProjectSearchHit[];
  /** How many projects were actually scanned, against how many exist. A search
   *  that stopped early must say so, or a missing result reads as proof the
   *  text is nowhere. */
  scanned: number;
  total: number;
  /** True when a limit -- projects, matches or the deadline -- stopped the
   *  scan before it had looked everywhere. */
  truncated: boolean;
}

/** Replacing every match of a search across the project's files.
 *
 *  One shot rather than match-by-match: the client already has the matches
 *  from `search`, and the server re-scans at replace time so files changed
 *  since are handled correctly rather than patched from stale positions. */
export interface ReplaceOptions {
  search: SearchOptions;
  /** What each match becomes. JavaScript replacement patterns ($1, $&…)
   *  apply when the search is a regular expression. */
  replacement: string;
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
  /** Asks for every source file at once, so the editor's language service can
   *  resolve a definition in a file the user has never opened. Read-only, so a
   *  viewer may ask. */
  projectSources: () => void;

  search: (payload: SearchOptions) => void;
  /** Replace every match across the project's files. */
  replaceInProject: (payload: ReplaceOptions) => void;

  // --- Shared editing ----------------------------------------------------
  //
  // While a file is open collaboratively the SERVER owns writing it to disk.
  // The client stops sending `writeFile` for that file entirely, so there is
  // one writer rather than two racing.

  /** Start editing a file together. The server replies with `docSync`. */
  docJoin: (payload: PathPayload) => void;
  /** Stop editing it. */
  docLeave: (payload: PathPayload) => void;
  /** Write the shared document to disk now.
   *
   *  While a file is edited together the SERVER owns writing it, on a debounce
   *  after the last change. Ctrl+S had no way to reach that, so it fell through
   *  to the ordinary client write path — which is suppressed for shared files —
   *  and saved nothing at all, or worse, flushed an older buffer left in the
   *  queue from before the document synced. */
  docSave: (payload: PathPayload) => void;
  /** A Yjs update produced locally. */
  docUpdate: (payload: { relPath: string; update: ArrayBuffer }) => void;
  /** Cursor and selection, for everyone else's benefit. Not persisted. */
  docAwareness: (payload: { relPath: string; update: ArrayBuffer }) => void;

  // --- Assistant ---------------------------------------------------------
  //
  // Rides this socket rather than a REST endpoint of its own: the reply is a
  // token stream, and this connection is already authenticated and pinned to
  // one project. `runOutput` streams the same way for the same reason.

  /** Ask a question. The reply arrives as `aiDelta`, then `aiDone`. */
  aiAsk: (payload: AiAskPayload) => void;
  /** Stop the reply in progress. Whatever has streamed already is kept. */
  aiCancel: () => void;
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
  /** Sent once on connect. The client uses it to present read-only access as
   *  read-only rather than letting every action fail one at a time. */
  projectAccess: (payload: { level: SocketData["accessLevel"] }) => void;

  /** The document's full state, in reply to `docJoin`. */
  docSync: (payload: { relPath: string; state: ArrayBuffer }) => void;
  /** Someone else's change. */
  docUpdate: (payload: { relPath: string; update: ArrayBuffer }) => void;
  /** Someone else's cursor. */
  docAwareness: (payload: { relPath: string; update: ArrayBuffer }) => void;
  /** How many people are editing this file, this client included. */
  docPeers: (payload: { relPath: string; count: number }) => void;
  /** The server wrote this shared document to disk.
   *
   *  While a file is edited together the server owns saving it, so the client
   *  never sends `writeFile` for it and never sees `writeFileSuccess`. Without
   *  this there was nothing at all to clear the tab's unsaved marker: every
   *  open file stayed dirty forever, every close asked for confirmation, and
   *  every reload raised the browser's unsaved-changes prompt — for work that
   *  had been on disk for some time.
   *
   *  Sent to everyone with the file open, because a shared document is one
   *  merged buffer: when it is saved it is saved for all of them. */
  docSaved: (payload: { relPath: string }) => void;
  /** The file changed on disk outside the editor while it was open.
   *
   *  Reported rather than merged: an external writer produces whole new
   *  contents with no record of which edits made them, so there is nothing to
   *  merge against. The people editing decide what to do. */
  docExternalChange: (payload: { relPath: string }) => void;
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
  /** The project's files changed while its dev server is live. The preview
   *  pane reloads on this rather than relying on the dev server's own
   *  hot-reload: on a bind mount that swallows inotify (Docker Desktop on
   *  Windows and macOS) a save reaches the disk but the watcher inside the
   *  container is never told, so nothing hot-reloads — the preview just sits
   *  there showing the previous render. A full reload asks the dev server
   *  directly, and dev servers compile on request, so the fresh render is
   *  built from what is on disk now. */
  previewChanged: () => void;
  /** The dev server answered the preview with an error — a compile failure,
   *  most often. Sent once per bout, not per failing request, and only for
   *  the page itself; asset traffic cannot flip this. */
  previewError: (payload: { status: number }) => void;
  /** The dev server is answering normally again after a reported error. */
  previewRecovered: () => void;
  /** Container resource use, in reply to statsRequest. */
  containerStats: (payload: ContainerStats) => void;
  /** Results for the most recent `search`. `truncated` means a limit stopped
   *  the scan, so the list is partial rather than complete. */
  /** Answer to `projectSources`. `truncated` says a cap stopped the walk, so
   *  navigation covers part of the project rather than all of it. */
  projectSources: (payload: {
    files: { relPath: string; contents: string }[];
    truncated: boolean;
  }) => void;

  searchResults: (payload: {
    query: string;
    matches: SearchMatch[];
    truncated: boolean;
  }) => void;
  /** Outcome of `replaceInProject`. `truncated` means a limit stopped the
   *  rewrite, so the list of files is partial and the search should be run
   *  again to see what is left. */
  replaceResult: (payload: {
    query: string;
    files: { relPath: string; replacements: number }[];
    replacements: number;
    truncated: boolean;
  }) => void;
  /** A piece of the assistant's answer. */
  aiDelta: (payload: { text: string }) => void;
  /** The assistant used a tool. Display only — see the note in ai.ts. */
  aiActivity: (payload: AiActivity) => void;
  /** The assistant would like to change a file. Nothing has been written: this
   *  is an offer for the user to review as a diff and accept or discard. */
  aiProposal: (payload: AiProposal) => void;
  /** The reply is finished, one way or another. */
  aiDone: (payload: { stopReason: AiStopReason }) => void;
  /** The reply failed. Separate from `error` because this belongs in the
   *  conversation, not in the editor's error banner. */
  aiError: (payload: { code: string; message: string }) => void;
  error: (payload: { code: string; message: string }) => void;
}

/** Data attached server-side to each socket by the handshake auth middleware,
 *  before any handler is registered. */
export interface SocketData {
  userId: string;
  projectId: string;
  /** What this connection may do. A visitor is reading a PUBLIC project and
   *  was invited by nobody; a viewer was invited. Both may read and watch, and
   *  anything that changes the project or runs code needs at least editor. */
  accessLevel: "visitor" | "viewer" | "editor" | "owner";
}
