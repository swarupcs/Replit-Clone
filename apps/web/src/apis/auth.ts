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

// Refresh is deliberately NOT exposed here. It must go through
// refreshAccessToken() in axiosConfig, whose shared in-flight promise stops
// concurrent refreshes from replaying the single-use refresh token and
// revoking the whole session.

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

/** What this server's sign-in screen may offer.
 *
 *  `singleUser` means the account-creating and account-recovering routes are
 *  not mounted at all, so the form must not link to them. */
export const getAuthProvidersApi = async (): Promise<{
  github: boolean;
  singleUser: boolean;
}> => {
  const response = await axios.get<{
    data: { github: boolean; singleUser?: boolean };
  }>("/api/v1/auth/providers");

  const data = response.data.data;
  // Defaulted rather than required, so a client talking to a server that
  // predates the mode reads as an ordinary multi-account deployment.
  return { github: data.github, singleUser: data.singleUser ?? false };
};

/** A full navigation, not a fetch: the OAuth round trip is the browser
 *  visiting GitHub and being sent back. */
export const githubSignInUrl = (): string =>
  `${import.meta.env.VITE_BACKEND_URL}/api/v1/auth/github`;
