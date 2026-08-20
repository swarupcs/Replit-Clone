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

export const requestPasswordResetApi = async (
  email: string,
): Promise<{ delivered: boolean }> => {
  const response = await axios.post<{ data: { delivered: boolean } }>(
    "/api/v1/auth/password-reset",
    { email },
  );
  return response.data.data;
};

export const resetPasswordApi = async (
  token: string,
  password: string,
): Promise<void> => {
  await axios.post("/api/v1/auth/password-reset/confirm", { token, password });
};

export const verifyEmailApi = async (token: string): Promise<void> => {
  await axios.post("/api/v1/auth/verify-email", { token });
};

export const requestEmailVerificationApi = async (): Promise<{
  delivered: boolean;
}> => {
  const response = await axios.post<{ data: { delivered: boolean } }>(
    "/api/v1/auth/verify-email/request",
  );
  return response.data.data;
};

/** Which sign-in providers this server has configured. */
export const getAuthProvidersApi = async (): Promise<{ github: boolean }> => {
  const response = await axios.get<{ data: { github: boolean } }>(
    "/api/v1/auth/providers",
  );
  return response.data.data;
};

/** A full navigation, not a fetch: the OAuth round trip is the browser
 *  visiting GitHub and being sent back. */
export const githubSignInUrl = (): string =>
  `${import.meta.env.VITE_BACKEND_URL}/api/v1/auth/github`;
