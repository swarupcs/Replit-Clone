import type {
  ApiSuccess,
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

export const createShareLinkApi = async (projectId: string): Promise<string> => {
  const response = await axios.post<ApiSuccess<{ shareToken: string }>>(
    `/api/v1/projects/${projectId}/share-link`,
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
