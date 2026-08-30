import type {
  ApiSuccess,
  CustomDomain,
  Deployment,
  DeploymentState,
} from "@replit-clone/shared";
import axios from "../config/axiosConfig.ts";

export const getDeploymentApi = async (
  projectId: string,
): Promise<DeploymentState> => {
  const response = await axios.get<ApiSuccess<DeploymentState>>(
    `/api/v1/projects/${projectId}/deployment`,
  );
  return response.data.data;
};

export const deployApi = async (projectId: string): Promise<Deployment> => {
  const response = await axios.post<ApiSuccess<Deployment>>(
    `/api/v1/projects/${projectId}/deployment`,
    {},
  );
  return response.data.data;
};

export const undeployApi = async (
  projectId: string,
): Promise<DeploymentState> => {
  const response = await axios.delete<ApiSuccess<DeploymentState>>(
    `/api/v1/projects/${projectId}/deployment`,
  );
  return response.data.data;
};

export const claimDomainApi = async (
  projectId: string,
  domain: string,
): Promise<CustomDomain> => {
  const response = await axios.put<ApiSuccess<CustomDomain>>(
    `/api/v1/projects/${projectId}/deployment/domain`,
    { domain },
  );
  return response.data.data;
};

export const verifyDomainApi = async (
  projectId: string,
): Promise<CustomDomain> => {
  const response = await axios.post<ApiSuccess<CustomDomain>>(
    `/api/v1/projects/${projectId}/deployment/domain/verify`,
    {},
  );
  return response.data.data;
};

export const releaseDomainApi = async (
  projectId: string,
): Promise<DeploymentState> => {
  const response = await axios.delete<ApiSuccess<DeploymentState>>(
    `/api/v1/projects/${projectId}/deployment/domain`,
  );
  return response.data.data;
};
