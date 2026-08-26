import type {
  GithubConnectResponse,
  GithubConnectionInfo,
  GithubImportResponse,
  GithubRepo,
  GithubReposResponse,
  GithubStatusResponse,
  Project,
} from "@replit-clone/shared";
import axios from "../config/axiosConfig.ts";

export const getGithubStatusApi = async (): Promise<{
  configured: boolean;
  connection: GithubConnectionInfo | null;
}> => {
  const response = await axios.get<GithubStatusResponse>("/api/v1/github/status");
  return response.data.data;
};

/** Asks for the authorisation URL. The browser then follows it — this call
 *  carries the session, and a plain link could not. */
export const startGithubConnectApi = async (): Promise<string> => {
  const response = await axios.post<GithubConnectResponse>(
    "/api/v1/github/connect",
  );
  return response.data.data.url;
};

export const disconnectGithubApi = async (): Promise<void> => {
  await axios.delete("/api/v1/github/connection");
};

export const listGithubReposApi = async (params: {
  query?: string;
  page?: number;
}): Promise<{ repos: GithubRepo[]; hasMore: boolean }> => {
  const response = await axios.get<GithubReposResponse>("/api/v1/github/repos", {
    params,
  });
  return response.data.data;
};

export const importGithubRepoApi = async (body: {
  owner: string;
  repo: string;
  ref?: string;
  name?: string;
}): Promise<Project> => {
  const response = await axios.post<GithubImportResponse>(
    "/api/v1/github/import",
    body,
  );
  return response.data.data.project;
};
