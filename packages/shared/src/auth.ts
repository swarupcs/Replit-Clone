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
