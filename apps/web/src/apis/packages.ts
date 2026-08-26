import type { ApiSuccess, PackageList } from "@replit-clone/shared";
import axios from "../config/axiosConfig.ts";

/** What a mutation reports back: the manager's own output, so a failed or
 *  noisy install can be read in the panel, and the manifest as it stands
 *  afterwards, so the list never has to be refetched separately. */
export interface PackageCommandResult {
  output: string;
  packages: PackageList;
}

export const listPackagesApi = async (
  projectId: string,
): Promise<PackageList> => {
  const response = await axios.get<ApiSuccess<PackageList>>(
    `/api/v1/projects/${projectId}/packages`,
  );
  return response.data.data;
};

export const addPackageApi = async (
  projectId: string,
  name: string,
  version?: string,
  dev?: boolean,
): Promise<PackageCommandResult> => {
  const response = await axios.post<ApiSuccess<PackageCommandResult>>(
    `/api/v1/projects/${projectId}/packages`,
    { name, version, dev },
  );
  return response.data.data;
};

export const removePackageApi = async (
  projectId: string,
  name: string,
): Promise<PackageCommandResult> => {
  // A body on DELETE, because the name identifies which dependency to drop
  // rather than which resource is being addressed -- the collection is.
  const response = await axios.delete<ApiSuccess<PackageCommandResult>>(
    `/api/v1/projects/${projectId}/packages`,
    { data: { name } },
  );
  return response.data.data;
};
