import type { AiStatus, ApiSuccess } from "@replit-clone/shared";
import axios from "../config/axiosConfig.ts";

/** Whether this deployment has an assistant configured.
 *
 *  Asked once when the playground mounts, so the panel is hidden outright
 *  rather than offered and then failing on the first question.
 */
export const getAiStatusApi = async (): Promise<AiStatus> => {
  const response = await axios.get<ApiSuccess<AiStatus>>("/api/v1/ai/status");
  return response.data.data;
};
