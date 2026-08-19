import type { AuthResponse, Credentials, PublicUser } from "@replit-clone/shared";
import axios from "../config/axiosConfig.ts";

export const signupApi = async (body: Credentials): Promise<AuthResponse> => {
  const response = await axios.post<AuthResponse>("/api/v1/auth/signup", body);
  return response.data;
};

export const loginApi = async (body: Credentials): Promise<AuthResponse> => {
  const response = await axios.post<AuthResponse>("/api/v1/auth/login", body);
  return response.data;
};

export const refreshApi = async (): Promise<AuthResponse> => {
  const response = await axios.post<AuthResponse>("/api/v1/auth/refresh");
  return response.data;
};

export const logoutApi = async (): Promise<void> => {
  await axios.post("/api/v1/auth/logout");
};

export const meApi = async (): Promise<PublicUser> => {
  const response = await axios.get<{ data: { user: PublicUser } }>(
    "/api/v1/auth/me",
  );
  return response.data.data.user;
};
