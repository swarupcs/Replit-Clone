import type {
  AuthProviders,
  AuthResponse,
  Credentials,
  DeploymentCapabilities,
  LoginResponse,
  PublicUser,
  TwoFactorEnrolment,
  TwoFactorStatus,
} from "@replit-clone/shared";
import axios from "../config/axiosConfig.ts";

export const signupApi = async (body: Credentials): Promise<AuthResponse> => {
  const response = await axios.post<AuthResponse>("/api/v1/auth/signup", body);
  return response.data;
};

/** Returns EITHER a session or a challenge. The union is the point: a caller
 *  that ignores the difference cannot accidentally read a token that is not
 *  there, because there is no field to read. plan.md §11.6. */
export const loginApi = async (body: Credentials): Promise<LoginResponse> => {
  const response = await axios.post<LoginResponse>("/api/v1/auth/login", body);
  return response.data;
};

/** The second half of a sign-in. The account is named by the signed challenge
 *  and never by this request, which is what stops it being a way to trade a
 *  code for a session on somebody else's account. */
export const loginTotpApi = async (
  mfaToken: string,
  code: string,
): Promise<AuthResponse> => {
  const response = await axios.post<AuthResponse>("/api/v1/auth/login/totp", {
    mfaToken,
    code,
  });
  return response.data;
};

export const twoFactorStatusApi = async (): Promise<TwoFactorStatus> => {
  const response = await axios.get<{ data: TwoFactorStatus }>("/api/v1/auth/2fa");
  return response.data.data;
};

export const beginTwoFactorApi = async (): Promise<TwoFactorEnrolment> => {
  const response = await axios.post<{ data: TwoFactorEnrolment }>(
    "/api/v1/auth/2fa/begin",
  );
  return response.data.data;
};

/** Returns the recovery codes, which are readable here and nowhere else, ever
 *  again. */
export const confirmTwoFactorApi = async (
  code: string,
): Promise<{ recoveryCodes: string[]; status: TwoFactorStatus }> => {
  const response = await axios.post<{
    data: { recoveryCodes: string[]; status: TwoFactorStatus };
  }>("/api/v1/auth/2fa/confirm", { code });
  return response.data.data;
};

/** Both of the operations that make an account weaker take the password
 *  again: a session is not consent to remove the protection on the account it
 *  belongs to. */
export const disableTwoFactorApi = async (
  password: string,
): Promise<TwoFactorStatus> => {
  const response = await axios.post<{ data: TwoFactorStatus }>(
    "/api/v1/auth/2fa/disable",
    { password },
  );
  return response.data.data;
};

export const regenerateRecoveryCodesApi = async (
  password: string,
): Promise<{ recoveryCodes: string[]; status: TwoFactorStatus }> => {
  const response = await axios.post<{
    data: { recoveryCodes: string[]; status: TwoFactorStatus };
  }>("/api/v1/auth/2fa/recovery-codes", { password });
  return response.data.data;
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
export const getAuthProvidersApi = async (): Promise<AuthProviders> => {
  const response = await axios.get<{
    data: {
      github: boolean;
      singleUser?: boolean;
      capabilities?: Partial<DeploymentCapabilities>;
    };
  }>("/api/v1/auth/providers");

  const data = response.data.data;

  // Every field is defaulted rather than required, so a client talking to a
  // server that predates any of this reads as an ordinary multi-account
  // deployment -- which is what it is. Defaulting the other way would hide
  // Share and Explore on every existing deployment the moment this shipped.
  return {
    github: data.github,
    singleUser: data.singleUser ?? false,
    capabilities: {
      sharing: data.capabilities?.sharing ?? true,
      moderation: data.capabilities?.moderation ?? true,
      operatorConsole: data.capabilities?.operatorConsole ?? true,
      gallery: data.capabilities?.gallery ?? true,
      plans: data.capabilities?.plans ?? true,
    },
  };
};

/** A full navigation, not a fetch: the OAuth round trip is the browser
 *  visiting GitHub and being sent back. */
export const githubSignInUrl = (): string =>
  `${import.meta.env.VITE_BACKEND_URL}/api/v1/auth/github`;
