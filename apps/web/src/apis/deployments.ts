import type {
  ApiSuccess,
  CustomDomain,
  Deployment,
  DeploymentState,
  DeploymentRelease,
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

/** The builds this project has published, newest first.
 *
 *  Reading is a viewer's; rolling back is the owner's, because it changes what
 *  strangers get at a public address — the same decision as publishing, in the
 *  other direction. Enforced on the server.
 */
export const listReleasesApi = async (
  projectId: string,
): Promise<DeploymentRelease[]> => {
  const response = await axios.get<ApiSuccess<{ releases: DeploymentRelease[] }>>(
    `/api/v1/projects/${projectId}/releases`,
  );
  return response.data.data.releases;
};

export const rollbackApi = async (
  projectId: string,
  releaseId: string,
): Promise<DeploymentRelease[]> => {
  const response = await axios.post<ApiSuccess<{ releases: DeploymentRelease[] }>>(
    `/api/v1/projects/${projectId}/releases/${releaseId}/rollback`,
    {},
  );
  return response.data.data.releases;
};
