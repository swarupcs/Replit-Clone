import type {
  CreateProjectResponse,
  ListProjectsResponse,
  Project,
  ProjectTreeResponse,
  TreeNodeData,
} from "@replit-clone/shared";
import axios from "../config/axiosConfig.ts";

export const createProjectApi = async (name?: string): Promise<Project> => {
  const response = await axios.post<CreateProjectResponse>("/api/v1/projects", {
    name,
  });
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
