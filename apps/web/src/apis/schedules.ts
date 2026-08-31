import type {
  ApiSuccess,
  ScheduledJob,
  ScheduledRun,
} from "@replit-clone/shared";
import axios from "../config/axiosConfig.ts";

/** Cron jobs for a project.
 *
 *  Reading is a viewer's and writing is the owner's, enforced on the server.
 *  Nothing here checks that — a client-side check on a grant this sharp would
 *  be a comfort rather than a control.
 */
export const listJobsApi = async (
  projectId: string,
): Promise<ScheduledJob[]> => {
  const response = await axios.get<ApiSuccess<{ jobs: ScheduledJob[] }>>(
    `/api/v1/projects/${projectId}/jobs`,
  );
  return response.data.data.jobs;
};

export interface JobInput {
  name: string;
  schedule: string;
  command: string;
  enabled?: boolean;
}

export const createJobApi = async (
  projectId: string,
  input: JobInput,
): Promise<ScheduledJob> => {
  const response = await axios.post<ApiSuccess<ScheduledJob>>(
    `/api/v1/projects/${projectId}/jobs`,
    input,
  );
  return response.data.data;
};

export const updateJobApi = async (
  projectId: string,
  jobId: string,
  input: Partial<JobInput>,
): Promise<ScheduledJob> => {
  const response = await axios.patch<ApiSuccess<ScheduledJob>>(
    `/api/v1/projects/${projectId}/jobs/${jobId}`,
    input,
  );
  return response.data.data;
};

export const deleteJobApi = async (
  projectId: string,
  jobId: string,
): Promise<void> => {
  await axios.delete(`/api/v1/projects/${projectId}/jobs/${jobId}`);
};

export const listRunsApi = async (
  projectId: string,
  jobId: string,
): Promise<ScheduledRun[]> => {
  const response = await axios.get<ApiSuccess<{ runs: ScheduledRun[] }>>(
    `/api/v1/projects/${projectId}/jobs/${jobId}/runs`,
  );
  return response.data.data.runs;
};

/** Runs a job now, outside its schedule.
 *
 *  Resolves with the run, which has already finished — the server waits for
 *  the command rather than starting it and returning, because the only reason
 *  to press this button is to find out what happens.
 */
export const runJobApi = async (
  projectId: string,
  jobId: string,
): Promise<ScheduledRun> => {
  const response = await axios.post<ApiSuccess<ScheduledRun>>(
    `/api/v1/projects/${projectId}/jobs/${jobId}/run`,
    {},
  );
  return response.data.data;
};
