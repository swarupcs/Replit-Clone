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
