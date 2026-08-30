import type { ApiSuccess, TestCommand, TestRun } from "@replit-clone/shared";
import axios from "../config/axiosConfig.ts";

/** A project's tests.
 *
 *  Reading the command is a viewer's, running it needs the grant `Run` needs,
 *  and changing it is the owner's. Enforced on the server; nothing here checks
 *  it, because a client-side check on a grant like that is a comfort rather
 *  than a control.
 */
export const getTestCommandApi = async (
  projectId: string,
): Promise<TestCommand> => {
  const response = await axios.get<ApiSuccess<TestCommand>>(
    `/api/v1/projects/${projectId}/test-command`,
  );
  return response.data.data;
};

export const setTestCommandApi = async (
  projectId: string,
  command: string,
): Promise<TestCommand> => {
  const response = await axios.put<ApiSuccess<TestCommand>>(
    `/api/v1/projects/${projectId}/test-command`,
    { command },
  );
  return response.data.data;
};

export const runTestsApi = async (projectId: string): Promise<TestRun> => {
  const response = await axios.post<ApiSuccess<{ run: TestRun }>>(
    `/api/v1/projects/${projectId}/test`,
    {},
  );
  return response.data.data.run;
};
