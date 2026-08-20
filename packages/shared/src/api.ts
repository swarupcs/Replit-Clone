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
