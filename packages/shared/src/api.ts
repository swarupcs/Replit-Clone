import type { Page } from "./pagination.js";
import type { TreeNodeData } from "./tree.js";

/** Every REST response uses this envelope. */
export interface ApiSuccess<T> {
  success: true;
  message: string;
  data: T;
}

export interface ApiFailure {
  success: false;
  code: string;
  message: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface Project {
  id: string;
  name: string;
  template: string;
  ownerId: string;
  createdAt: string;
  lastActiveAt: string | null;
  /** Whether anybody signed in may read this project and fork it. The row's
   *  own spelling, since this is the project as the API returns it. */
  visibility: "PRIVATE" | "PUBLIC";
  /** The public project this was forked from, or null. Provenance only: it
   *  grants nothing and survives the original being deleted. */
  forkedFromId: string | null;
  /** When a moderator took this project down after a report, or null.
   *
   *  Returned to the owner because it is a fact about them and the dashboard
   *  is where they would look for it. What it stops is spelled out in
   *  `packages/shared/src/moderation.ts`. */
  takenDownAt: string | null;
  /** Absolute host path when this project is a folder somebody opened rather
   *  than a tree this server created, and null otherwise.
   *
   *  Returned because the difference is visible in what the product will do:
   *  deleting one closes it and leaves the files, its disk is not counted
   *  against the account, and the path is the only way to tell two folders with
   *  the same basename apart. Absent on older responses, hence optional. */
  localPath?: string | null;
}

/** POST /api/v1/projects */
export type CreateProjectResponse = ApiSuccess<Project>;

/** What this deployment will let somebody open from disk.
 *
 *  `enabled` is false when LOCAL_FOLDER_ROOTS is unset, which is the default
 *  and is the state every multi-tenant deployment should stay in. The screen
 *  asks first so it can say "not configured" rather than offering a picker that
 *  refuses everything. */
export interface LocalFolderSettings {
  enabled: boolean;
  /** The directories that may be opened from, or below. */
  roots: string[];
}

/** One directory offered while choosing a folder. */
export interface LocalFolderEntry {
  /** Absolute, and what is sent back to open or to browse deeper. */
  path: string;
  /** The last segment, which is what a person reads. */
  name: string;
}

/** GET /api/v1/projects/local */
export type LocalFolderSettingsResponse = ApiSuccess<LocalFolderSettings>;

/** GET /api/v1/projects/local/browse */
export type LocalFolderBrowseResponse = ApiSuccess<{
  path: string;
  entries: LocalFolderEntry[];
}>;

/** POST /api/v1/projects/local */
export type OpenLocalFolderResponse = ApiSuccess<Project>;

/** GET /api/v1/projects — one page of them; see `Page`. */
export type ListProjectsResponse = ApiSuccess<Page<Project>>;

/** GET /api/v1/projects/:projectId/tree */
export type ProjectTreeResponse = ApiSuccess<TreeNodeData | null>;

/** A project template offered at creation time. */
export interface TemplateSummary {
  id: string;
  label: string;
  /** Port the dev server listens on inside the container. */
  devPort: number;
  /** Every port this template's preview may be pointed at, dev port first. */
  previewPorts: number[];
  /** Shown in the UI so the user knows what to run. */
  startCommand: string;
}

/** GET /api/v1/projects/:projectId/ports */
export type ProjectPortsResponse = ApiSuccess<{
  devPort: number;
  ports: number[];
}>;

/** GET /api/v1/projects/templates */
export type ListTemplatesResponse = ApiSuccess<TemplateSummary[]>;

/* ---------------------------------------------------------------- source control */

/** How one path differs, on one side of the index. */
export type GitChangeState =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked";

export interface GitChange {
  path: string;
  /** Set only for a rename, naming where the file came from. */
  from?: string;
  /** What the index has, versus HEAD. */
  staged?: GitChangeState;
  /** What the working tree has, versus the index. */
  unstaged?: GitChangeState;
}

export interface GitStatus {
  /** False when the project has no repository yet, in which case nothing else
   *  here is meaningful. */
  isRepo: boolean;
  branch?: string;
  /** Commits ahead of / behind the upstream, when there is one. */
  ahead?: number;
  behind?: number;
  /** True before the first commit, when HEAD points at an unborn branch. */
  unborn?: boolean;
  changes: GitChange[];
}

export interface GitBranch {
  name: string;
  /** True for the branch HEAD is on. */
  current: boolean;
}

export interface GitRemote {
  name: string;
  /** The fetch URL. Push URLs are not modelled: nothing here can set one. */
  url: string;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

/** GET /api/v1/projects/:projectId/git/status */
export type GitStatusResponse = ApiSuccess<GitStatus>;

/** GET /api/v1/projects/:projectId/git/log */
export type GitLogResponse = ApiSuccess<GitCommit[]>;

/** GET /api/v1/projects/:projectId/git/branches */
export type GitBranchesResponse = ApiSuccess<GitBranch[]>;

/** POST /api/v1/projects/:projectId/git/branch — create, or switch to, a
 *  branch. Both answer with the resulting status so the panel can redraw from
 *  one round trip. */
export type GitBranchResponse = ApiSuccess<{
  status: GitStatus;
  branches: GitBranch[];
}>;

/** GET /api/v1/projects/:projectId/git/remotes */
export type GitRemotesResponse = ApiSuccess<GitRemote[]>;

/** POST /api/v1/projects/:projectId/git/remote — add or remove one. */
export type GitRemoteResponse = ApiSuccess<GitRemote[]>;

/** POST /api/v1/projects/:projectId/git/pull — and /git/fetch. */
export type GitPullResponse = ApiSuccess<GitStatus>;

/** What one sync did, leg by leg.
 *
 *  Reported rather than inferred from the resulting status: "behind 0" after a
 *  sync is equally true of a pull that fast-forwarded ten commits and of a
 *  branch that was already current, and a control that cannot tell those apart
 *  is one people stop trusting. Each leg says whether it MOVED anything, and
 *  `skipped` says why a leg that could have run did not.
 */
export interface GitSyncResult {
  status: GitStatus;
  /** The remote and branch the sync actually used, having resolved them. */
  remote: string;
  branch: string;
  /** A fetch always runs; these two ran only when there was something to do. */
  pulled: number;
  pushed: number;
  /** Present when the push leg was deliberately not attempted. `null` when it
   *  ran, or when there was nothing to push. */
  pushSkipped: GitPushSkipReason | null;
  /** One line, already phrased for a person. */
  summary: string;
}

/** Why a sync fetched and pulled but did not push.
 *
 *  Not errors — a sync that pulled is a sync that did something useful, and
 *  failing the whole call because the push half was not available would throw
 *  that away. The panel says which of these happened.
 */
export type GitPushSkipReason =
  /** The project has a collaborator or a live share link, so the credential
   *  would be readable by someone else. Same rule as /git/push. */
  | "PROJECT_IS_SHARED"
  /** No connected GitHub account and no token supplied. */
  | "NO_CREDENTIAL"
  /** The remote is not GitHub, so the stored connection cannot pay for it. */
  | "REMOTE_NOT_GITHUB";

/** POST /api/v1/projects/:projectId/git/sync */
export type GitSyncResponse = ApiSuccess<GitSyncResult>;

/** GET /api/v1/projects/:projectId/git/diff */
export type GitDiffResponse = ApiSuccess<{
  path: string;
  staged: boolean;
  patch: string;
}>;

/** POST /api/v1/projects/:projectId/git/commit */
export type GitCommitResponse = ApiSuccess<{
  status: GitStatus;
  commits: GitCommit[];
}>;

// --- GitHub ---------------------------------------------------------------

/** What the app is told about the caller's GitHub authorisation.
 *
 *  Never the token. This is the description of a connection, not the
 *  credential: the token is spent server-side and does not reach a browser.
 */
export interface GithubConnectionInfo {
  login: string;
  scopes: string[];
  connectedAt: string;
  /** Whether GitHub actually granted `repo`. An organisation can withhold it,
   *  and the app should say which operation is unavailable and why rather than
   *  failing later at an API call. */
  canUseRepos: boolean;
}

/** GET /api/v1/github/status
 *
 *  `configured` and `connection` answer different questions: whether this
 *  deployment offers the feature at all, and whether this user has said yes. */
export type GithubStatusResponse = ApiSuccess<{
  configured: boolean;
  connection: GithubConnectionInfo | null;
}>;

/** POST /api/v1/github/connect — where to send the browser to authorise. */
export type GithubConnectResponse = ApiSuccess<{ url: string }>;

/** One of the caller's GitHub repositories, reduced to what a picker needs. */
export interface GithubRepo {
  id: number;
  /** "owner/name", which is how people refer to one. */
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  /** Kilobytes, as GitHub reports it — enough to refuse an import that cannot
   *  fit before it is attempted. */
  sizeKb: number;
  language: string | null;
  pushedAt: string | null;
}

/** GET /api/v1/github/repos?query=&page= */
export type GithubReposResponse = ApiSuccess<{
  repos: GithubRepo[];
  hasMore: boolean;
}>;

/** POST /api/v1/github/import */
export type GithubImportResponse = ApiSuccess<{ project: Project }>;

/** A pull request, reduced to what the source-control panel shows. */
export interface GithubPullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  head: string;
  base: string;
}

/** GET /api/v1/projects/:projectId/github/pulls?head= */
export type GithubPullsResponse = ApiSuccess<GithubPullRequest[]>;

/** POST /api/v1/projects/:projectId/github/pulls */
export type GithubPullResponse = ApiSuccess<GithubPullRequest>;

/** GET /api/v1/projects/:projectId/github/repo — null when the project's
 *  remotes point somewhere that is not GitHub. */
export type GithubProjectRepoResponse = ApiSuccess<{
  owner: string;
  repo: string;
  url: string;
} | null>;

/** GET / PUT /api/v1/projects/:projectId/start-command
 *
 *  Both values, because "npm run dev" alone does not say whether it is the
 *  project's own choice or the template's — and which it is decides whether
 *  clearing the field would help. */
export type StartCommandResponse = ApiSuccess<{
  command: string | null;
  templateDefault: string;
}>;
