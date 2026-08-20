import type {
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
