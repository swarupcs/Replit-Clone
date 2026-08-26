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
}

/** POST /api/v1/projects */
export type CreateProjectResponse = ApiSuccess<Project>;

/** GET /api/v1/projects */
export type ListProjectsResponse = ApiSuccess<Project[]>;

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
