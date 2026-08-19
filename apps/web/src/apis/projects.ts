import type {
  CreateProjectResponse,
  ProjectTreeResponse,
  TreeNodeData,
} from "@replit-clone/shared";
import axios from "../config/axiosConfig.ts";

export const createProjectApi = async (): Promise<CreateProjectResponse> => {
  const response = await axios.post<CreateProjectResponse>("/api/v1/projects");
  return response.data;
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
