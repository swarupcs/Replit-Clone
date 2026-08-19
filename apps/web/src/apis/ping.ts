import type { PingResponse } from "@replit-clone/shared";
import axios from "../config/axiosConfig.ts";

export const pingApi = async (): Promise<PingResponse> => {
  const response = await axios.get<PingResponse>("/api/v1/ping");
  return response.data;
};
