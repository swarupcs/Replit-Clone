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
