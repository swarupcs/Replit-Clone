import type {
  ApiSuccess,
  GitBranch,
  GitRemote,
  GitRemoteResponse,
  GitRemotesResponse,
  GitBranchResponse,
  GitBranchesResponse,
  GitCommit,
  GitCommitResponse,
  GitDiffResponse,
  GitLogResponse,
  GitStatus,
  GitStatusResponse,
  ListTemplatesResponse,
  TemplateSummary,
  CreateProjectResponse,
  ListProjectsResponse,
  Project,
  ProjectPortsResponse,
  ProjectTreeResponse,
  TreeNodeData,
  GithubPullRequest,
  GithubPullsResponse,
  GithubPullResponse,
  GithubProjectRepoResponse,
  StartCommandResponse,
} from "@replit-clone/shared";
import axios from "../config/axiosConfig.ts";

export const createProjectApi = async (
  name?: string,
  template?: string,
): Promise<Project> => {
  const response = await axios.post<CreateProjectResponse>("/api/v1/projects", {
    name,
    template,
  });
  return response.data.data;
};

export const listTemplatesApi = async (): Promise<TemplateSummary[]> => {
  const response = await axios.get<ListTemplatesResponse>(
    "/api/v1/projects/templates",
  );
  return response.data.data;
};

export const listProjectsApi = async (): Promise<Project[]> => {
  const response = await axios.get<ListProjectsResponse>("/api/v1/projects");
  return response.data.data;
};

export const deleteProjectApi = async (projectId: string): Promise<void> => {
  await axios.delete(`/api/v1/projects/${projectId}`);
};

export const getProjectTree = async ({
  projectId,
}: {
  projectId: string;
}): Promise<TreeNodeData | null> => {
  const response = await axios.get<ProjectTreeResponse>(
    `/api/v1/projects/${projectId}/tree`,
  );
  return response.data.data;
};

export const getProjectPorts = async (
  projectId: string,
): Promise<{ devPort: number; ports: number[] }> => {
  const response = await axios.get<ProjectPortsResponse>(
    `/api/v1/projects/${projectId}/ports`,
  );
  return response.data.data;
};

export const renameProjectApi = async (
  projectId: string,
  name: string,
): Promise<Project> => {
  const response = await axios.patch<CreateProjectResponse>(
    `/api/v1/projects/${projectId}`,
    { name },
  );
  return response.data.data;
};

export const duplicateProjectApi = async (
  projectId: string,
  name?: string,
): Promise<Project> => {
  const response = await axios.post<CreateProjectResponse>(
    `/api/v1/projects/${projectId}/duplicate`,
    { name },
  );
  return response.data.data;
};

/** Absolute, because the browser navigates to it rather than fetching it —
 *  a download has to be a real navigation for the filename to be honoured. */
export const projectExportUrl = (projectId: string): string =>
  `${import.meta.env.VITE_BACKEND_URL}/api/v1/projects/${projectId}/export`;

export const getProjectEnvApi = async (
  projectId: string,
): Promise<Record<string, string>> => {
  const response = await axios.get<ApiSuccess<Record<string, string>>>(
    `/api/v1/projects/${projectId}/env`,
  );
  return response.data.data;
};

export const setProjectEnvApi = async (
  projectId: string,
  vars: Record<string, string>,
): Promise<Record<string, string>> => {
  const response = await axios.put<ApiSuccess<Record<string, string>>>(
    `/api/v1/projects/${projectId}/env`,
    { vars },
  );
  return response.data.data;
};

export const uploadFilesApi = async (
  projectId: string,
  files: File[],
  destDir = "",
): Promise<string[]> => {
  const form = new FormData();
  form.append("destDir", destDir);
  for (const file of files) form.append("files", file);

  const response = await axios.post<ApiSuccess<{ paths: string[] }>>(
    `/api/v1/projects/${projectId}/files`,
    form,
  );
  return response.data.data.paths;
};

/** Absolute, because the browser navigates to it — a download has to be a real
 *  navigation for the filename to be honoured. */
export const fileDownloadUrl = (projectId: string, relPath: string): string =>
  `${import.meta.env.VITE_BACKEND_URL}/api/v1/projects/${projectId}/files` +
  `?path=${encodeURIComponent(relPath)}`;

export type ProjectRole = "VIEWER" | "EDITOR";
export type AccessLevel = "none" | "viewer" | "editor" | "owner";

export interface Collaborator {
  userId: string;
  email: string;
  role: ProjectRole;
}

export interface SharingState {
  level: AccessLevel;
  collaborators: Collaborator[];
  shareToken: string | null;
  /** What the active link grants; null when no link exists. */
  shareRole: ProjectRole | null;
}

export const getSharingApi = async (projectId: string): Promise<SharingState> => {
  const response = await axios.get<ApiSuccess<SharingState>>(
    `/api/v1/projects/${projectId}/sharing`,
  );
  return response.data.data;
};

export const setCollaboratorApi = async (
  projectId: string,
  email: string,
  role: ProjectRole,
): Promise<Collaborator> => {
  const response = await axios.put<ApiSuccess<Collaborator>>(
    `/api/v1/projects/${projectId}/collaborators`,
    { email, role },
  );
  return response.data.data;
};

export const removeCollaboratorApi = async (
  projectId: string,
  userId: string,
): Promise<void> => {
  await axios.delete(`/api/v1/projects/${projectId}/collaborators/${userId}`);
};

/** Creates a new link granting `role`; any earlier link stops working. */
export const createShareLinkApi = async (
  projectId: string,
  role: ProjectRole = "VIEWER",
): Promise<string> => {
  const response = await axios.post<ApiSuccess<{ shareToken: string }>>(
    `/api/v1/projects/${projectId}/share-link`,
    { role },
  );
  return response.data.data.shareToken;
};

export const revokeShareLinkApi = async (projectId: string): Promise<void> => {
  await axios.delete(`/api/v1/projects/${projectId}/share-link`);
};

export const previewShareLinkApi = async (
  token: string,
): Promise<{ name: string; template: string } | null> => {
  const response = await axios.get<ApiSuccess<{ name: string; template: string } | null>>(
    `/api/v1/projects/share/preview?token=${encodeURIComponent(token)}`,
  );
  return response.data.data;
};

export const redeemShareLinkApi = async (token: string): Promise<Project> => {
  const response = await axios.post<CreateProjectResponse>(
    "/api/v1/projects/share/redeem",
    { token },
  );
  return response.data.data;
};

/** The URL to hand to someone. */
export const shareLinkUrl = (token: string): string =>
  `${window.location.origin}/join?token=${encodeURIComponent(token)}`;

/* ---------------------------------------------------------------- source control */

export const getGitStatusApi = async (
  projectId: string,
): Promise<GitStatus> => {
  const response = await axios.get<GitStatusResponse>(
    `/api/v1/projects/${projectId}/git/status`,
  );
  return response.data.data;
};

export const gitInitApi = async (projectId: string): Promise<GitStatus> => {
  const response = await axios.post<GitStatusResponse>(
    `/api/v1/projects/${projectId}/git/init`,
  );
  return response.data.data;
};

export const getGitDiffApi = async (
  projectId: string,
  path: string,
  staged: boolean,
): Promise<string> => {
  const response = await axios.get<GitDiffResponse>(
    `/api/v1/projects/${projectId}/git/diff`,
    { params: { path, staged: staged ? "true" : "false" } },
  );
  return response.data.data.patch;
};

export const gitStageApi = async (
  projectId: string,
  paths: string[],
): Promise<GitStatus> => {
  const response = await axios.post<GitStatusResponse>(
    `/api/v1/projects/${projectId}/git/stage`,
    { paths },
  );
  return response.data.data;
};

export const gitUnstageApi = async (
  projectId: string,
  paths: string[],
): Promise<GitStatus> => {
  const response = await axios.post<GitStatusResponse>(
    `/api/v1/projects/${projectId}/git/unstage`,
    { paths },
  );
  return response.data.data;
};

export const gitCommitApi = async (
  projectId: string,
  message: string,
): Promise<{ status: GitStatus; commits: GitCommit[] }> => {
  const response = await axios.post<GitCommitResponse>(
    `/api/v1/projects/${projectId}/git/commit`,
    { message },
  );
  return response.data.data;
};

export const getGitLogApi = async (
  projectId: string,
  limit = 20,
): Promise<GitCommit[]> => {
  const response = await axios.get<GitLogResponse>(
    `/api/v1/projects/${projectId}/git/log`,
    { params: { limit } },
  );
  return response.data.data;
};

export const getGitBranchesApi = async (
  projectId: string,
): Promise<GitBranch[]> => {
  const response = await axios.get<GitBranchesResponse>(
    `/api/v1/projects/${projectId}/git/branches`,
  );
  return response.data.data;
};

/** Switches to `name`, or creates it at HEAD when `create` is set. Answers with
 *  both the new status and the new branch list, so the panel redraws from one
 *  round trip. */
export const gitBranchApi = async (
  projectId: string,
  name: string,
  create = false,
): Promise<{ status: GitStatus; branches: GitBranch[] }> => {
  const response = await axios.post<GitBranchResponse>(
    `/api/v1/projects/${projectId}/git/branch`,
    { name, create },
  );
  return response.data.data;
};

/** Throws away local changes to these paths. Destructive and not undoable —
 *  the caller confirms first. */
export const gitDiscardApi = async (
  projectId: string,
  paths: string[],
): Promise<GitStatus> => {
  const response = await axios.post<GitStatusResponse>(
    `/api/v1/projects/${projectId}/git/discard`,
    { paths },
  );
  return response.data.data;
};

/** Stages, or unstages, individual hunks of one file.
 *
 *  Hunks are named by INDEX into the diff the server just produced, never by
 *  patch text — the server rebuilds the patch from its own diff, so a client
 *  cannot stage something nobody chose. */
export const gitHunksApi = async (
  projectId: string,
  path: string,
  indexes: number[],
  reverse = false,
): Promise<GitStatus> => {
  const response = await axios.post<GitStatusResponse>(
    `/api/v1/projects/${projectId}/git/hunks`,
    { path, indexes, reverse },
  );
  return response.data.data;
};

export const getGitRemotesApi = async (
  projectId: string,
): Promise<GitRemote[]> => {
  const response = await axios.get<GitRemotesResponse>(
    `/api/v1/projects/${projectId}/git/remotes`,
  );
  return response.data.data;
};

/** Adds a remote, or removes it when `remove` is set. */
export const gitRemoteApi = async (
  projectId: string,
  name: string,
  url?: string,
  remove = false,
): Promise<GitRemote[]> => {
  const response = await axios.post<GitRemoteResponse>(
    `/api/v1/projects/${projectId}/git/remote`,
    { name, url, remove },
  );
  return response.data.data;
};

export const gitFetchApi = async (
  projectId: string,
  name: string,
): Promise<GitStatus> => {
  const response = await axios.post<GitStatusResponse>(
    `/api/v1/projects/${projectId}/git/fetch`,
    { name },
  );
  return response.data.data;
};

export const gitPullApi = async (
  projectId: string,
  name: string,
  branch: string,
): Promise<GitStatus> => {
  const response = await axios.post<GitStatusResponse>(
    `/api/v1/projects/${projectId}/git/pull`,
    { name, branch },
  );
  return response.data.data;
};

/** Pushes a branch.
 *
 *  The token is optional: without one the server uses the caller's connected
 *  GitHub account. When there is one it is never stored anywhere on the client
 *  — not in a store, not in localStorage, not in the URL. It is read from an
 *  input, sent, and dropped.
 */
export const gitPushApi = async (
  projectId: string,
  name: string,
  branch: string,
  token?: string,
): Promise<GitStatus> => {
  const response = await axios.post<GitStatusResponse>(
    `/api/v1/projects/${projectId}/git/push`,
    { name, branch, ...(token ? { token } : {}) },
  );
  return response.data.data;
};

/** Open pull requests for a branch, so the panel can point at an existing one
 *  rather than failing on a second attempt to create it. */
export const getGithubPullsApi = async (
  projectId: string,
  head?: string,
): Promise<GithubPullRequest[]> => {
  const response = await axios.get<GithubPullsResponse>(
    `/api/v1/projects/${projectId}/github/pulls`,
    { params: head ? { head } : {} },
  );
  return response.data.data;
};

export const createGithubPullApi = async (
  projectId: string,
  body: { title: string; head: string; base: string; description?: string },
): Promise<GithubPullRequest> => {
  const response = await axios.post<GithubPullResponse>(
    `/api/v1/projects/${projectId}/github/pulls`,
    {
      title: body.title,
      head: body.head,
      base: body.base,
      ...(body.description ? { body: body.description } : {}),
    },
  );
  return response.data.data;
};

/** Which GitHub repository this project points at, or null. */
export const getGithubProjectRepoApi = async (
  projectId: string,
): Promise<{ owner: string; repo: string; url: string } | null> => {
  const response = await axios.get<GithubProjectRepoResponse>(
    `/api/v1/projects/${projectId}/github/repo`,
  );
  return response.data.data;
};

export const getStartCommandApi = async (
  projectId: string,
): Promise<{ command: string | null; templateDefault: string }> => {
  const response = await axios.get<StartCommandResponse>(
    `/api/v1/projects/${projectId}/start-command`,
  );
  return response.data.data;
};

/** An empty string means "go back to the template's default", which is the
 *  only way to undo a bad edit without knowing what the default was. */
export const setStartCommandApi = async (
  projectId: string,
  command: string,
): Promise<{ command: string | null; templateDefault: string }> => {
  const response = await axios.put<StartCommandResponse>(
    `/api/v1/projects/${projectId}/start-command`,
    { command },
  );
  return response.data.data;
};

// --- Database (query editor) ---

export interface DatabaseConnection {
  engine: string;
  /** "host:port". Never the credentials — the server does not send them. */
  label: string;
}

export interface QueryColumn {
  name: string;
  dataTypeId: number;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: unknown[][];
  rowCount: number;
  /** True when the row cap cut the result short. Shown, rather than letting
   *  part of an answer read as all of it. */
  truncated: boolean;
  durationMs: number;
}

export interface IntrospectedColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
}

export interface IntrospectedTable {
  schema: string;
  name: string;
  kind: "table" | "view";
  columns: IntrospectedColumn[];
}

export const getDatabaseConnectionApi = async (
  projectId: string,
): Promise<DatabaseConnection | null> => {
  const response = await axios.get<{ data: DatabaseConnection | null }>(
    `/api/v1/projects/${projectId}/database`,
  );
  return response.data.data;
};

export const setDatabaseConnectionApi = async (
  projectId: string,
  url: string,
): Promise<DatabaseConnection> => {
  const response = await axios.put<{ data: DatabaseConnection }>(
    `/api/v1/projects/${projectId}/database`,
    { url },
  );
  return response.data.data;
};

export const removeDatabaseConnectionApi = async (
  projectId: string,
): Promise<void> => {
  await axios.delete(`/api/v1/projects/${projectId}/database`);
};

export const getDatabaseSchemaApi = async (
  projectId: string,
): Promise<IntrospectedTable[]> => {
  const response = await axios.get<{ data: IntrospectedTable[] }>(
    `/api/v1/projects/${projectId}/database/schema`,
  );
  return response.data.data;
};

export const runDatabaseQueryApi = async (
  projectId: string,
  sql: string,
): Promise<QueryResult> => {
  const response = await axios.post<{ data: QueryResult }>(
    `/api/v1/projects/${projectId}/database/query`,
    { sql },
  );
  return response.data.data;
};

// --- Database (MongoDB) ---
//
// Separate calls rather than the SQL ones switching on engine: a filter
// document and a statement have nothing in common, and §7.6 is explicit that
// pretending otherwise produces something wrong about both databases.

export interface MongoCollection {
  database: string;
  name: string;
  kind: "collection" | "view";
}

export interface InferredField {
  name: string;
  /** Every BSON type seen for this field — a field need not hold one type. */
  types: string[];
  /** Fraction of the sampled documents that had it, 0–1. */
  presence: number;
}

export interface CollectionSchema {
  database: string;
  collection: string;
  /** Documents the sample actually saw. This is what makes the field list
   *  inferred rather than declared, so the UI shows it. */
  sampled: number;
  fields: InferredField[];
}

export interface MongoQueryResult {
  /** Relaxed-EJSON documents, already plain JSON. */
  documents: unknown[];
  fields: string[];
  documentCount: number;
  truncated: boolean;
  durationMs: number;
}

export const getMongoCollectionsApi = async (
  projectId: string,
): Promise<MongoCollection[]> => {
  const response = await axios.get<{ data: MongoCollection[] }>(
    `/api/v1/projects/${projectId}/database/collections`,
  );
  return response.data.data;
};

export const getMongoCollectionSchemaApi = async (
  projectId: string,
  database: string,
  collection: string,
): Promise<CollectionSchema> => {
  const response = await axios.get<{ data: CollectionSchema }>(
    `/api/v1/projects/${projectId}/database/collection-schema`,
    { params: { database, collection } },
  );
  return response.data.data;
};

export const runMongoQueryApi = async (
  projectId: string,
  request: {
    database: string;
    collection: string;
    mode: "find" | "aggregate";
    text: string;
    sort?: string;
    limit?: number;
    skip?: number;
  },
): Promise<MongoQueryResult> => {
  const response = await axios.post<{ data: MongoQueryResult }>(
    `/api/v1/projects/${projectId}/database/mongo-query`,
    request,
  );
  return response.data.data;
};

export const getDatabaseTableApi = async (
  projectId: string,
  schema: string,
  table: string,
  limit: number,
  offset: number,
): Promise<QueryResult> => {
  const response = await axios.get<{ data: QueryResult }>(
    `/api/v1/projects/${projectId}/database/table`,
    { params: { schema, table, limit, offset } },
  );
  return response.data.data;
};
