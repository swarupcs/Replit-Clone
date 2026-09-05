import { z } from "zod";

/** Validation shared by the API and the web forms, so the client cannot
 *  submit something the server will reject for a reason it did not show. */
export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(200, "Password is too long"),
});

export type Credentials = z.infer<typeof credentialsSchema>;

export interface PublicUser {
  id: string;
  email: string;
  /** Whether this account is on the server's `ADMIN_EMAILS` allowlist.
   *
   *  A hint for the interface and nothing more: it decides whether the report
   *  queue is offered, not whether it can be opened. Every admin route checks
   *  the allowlist again server-side, so a client that sets this to true for
   *  itself gets a link to a page that answers 403.
   */
  isAdmin: boolean;
}

export interface AuthResponse {
  success: true;
  message: string;
  data: {
    user: PublicUser;
    accessToken: string;
  };
}

/** What `POST /auth/login` answers when the account has a second factor.
 *
 *  A different shape rather than an `AuthResponse` with empty fields, so a
 *  client cannot read `data.accessToken` off a half-finished sign-in and
 *  believe it has a session. There is no user and no token here because the
 *  server has not issued either -- and it has not written the cookies either.
 *  plan.md §11.6.
 */
export interface MfaChallengeResponse {
  success: true;
  message: string;
  data: {
    mfaRequired: true;
    /** Short-lived proof that the PASSWORD step passed. Not a credential: it
     *  is signed with its own type and `requireAuth` refuses it. */
    mfaToken: string;
  };
}

export type LoginResponse = AuthResponse | MfaChallengeResponse;

/** Which of the two came back. A type guard rather than a bare check at each
 *  call site, so the narrowing is stated once. */
export function isMfaChallenge(
  response: LoginResponse,
): response is MfaChallengeResponse {
  return "mfaRequired" in response.data;
}

/** Whether an account is protected by a second factor, and how well. */
export interface TwoFactorStatus {
  enabled: boolean;
  /** A setup started and never confirmed. Shown rather than hidden: it is the
   *  state somebody is most likely to be stuck in. */
  pending: boolean;
  /** Zero with `enabled` true is a real and dangerous state -- a lost phone is
   *  then a lost account -- so it is a number rather than a boolean. */
  recoveryCodesLeft: number;
}

export interface TwoFactorEnrolment {
  /** The text form, for an app that cannot scan. */
  secret: string;
  /** The `otpauth://` URL, for one that can. */
  otpauthUrl: string;
}

export interface ApiErrorResponse {
  success: false;
  code: string;
  message: string;
}

/** What a deployment has routes for.
 *
 *  Each of these is false only in single-user mode, and each is dead by
 *  arithmetic there rather than by preference: a share link is redeemed by a
 *  second account, a report needs a reporter and a separate operator, the
 *  console administers accounts, and the gallery lists what other people
 *  published. See `config/deploymentMode.ts` on the server, where the decision
 *  is made once.
 *
 *  The app reads this to avoid drawing controls whose endpoints are 404s. */
export interface DeploymentCapabilities {
  sharing: boolean;
  moderation: boolean;
  operatorConsole: boolean;
  gallery: boolean;
  plans: boolean;
}

/** GET /api/v1/auth/providers */
export interface AuthProviders {
  github: boolean;
  /** One account, provisioned from the server's environment. */
  singleUser: boolean;
  capabilities: DeploymentCapabilities;
}
