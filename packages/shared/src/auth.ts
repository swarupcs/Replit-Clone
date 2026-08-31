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
