/** Credentials for things that are not people.
 *
 *  What makes this a different object from every other token here is not how
 *  it is generated but where it lives: on a CI runner, for months, presented
 *  on every request. So the questions it has to answer are what it may do, how
 *  it is revoked, and whether anybody can tell it is still in use — none of
 *  which a session token has to answer at all.
 */

/** What a key may do.
 *
 *  Deliberately three, and deliberately not "everything the account can do".
 *  A key is long-lived and stored somewhere a person is not looking, so
 *  handing it the full session surface would mean a leaked CI secret can
 *  delete every project, read every environment variable and change what the
 *  account pays for.
 *
 *  Two things are excluded by construction rather than by a check: an API key
 *  can never manage API keys, and it can never touch the account or moderation.
 *  Those routes are not on the surface a key can reach at all — see the server's
 *  `routes/v1/pub.ts`. A rule enforced by a route not existing is stronger than
 *  one enforced by remembering to check.
 */
export type ApiKeyScope =
  /** Read what this account owns or collaborates on. */
  | "projects:read"
  /** Create projects. */
  | "projects:write"
  /** Publish a project that already exists. */
  | "deploy";

export const API_KEY_SCOPES: ApiKeyScope[] = [
  "projects:read",
  "projects:write",
  "deploy",
];

export const SCOPE_LABEL: Record<ApiKeyScope, string> = {
  "projects:read": "Read projects",
  "projects:write": "Create projects",
  deploy: "Publish deployments",
};

/** A key as it can safely be listed: everything except the secret, which is
 *  not stored and therefore cannot be shown again. */
export interface ApiKeySummary {
  id: string;
  label: string;
  /** The public half, which is enough to tell two keys apart in a list and
   *  useless on its own. */
  prefix: string;
  scopes: ApiKeyScope[];
  /** Null until it has been used. The answer to "is anything still using
   *  this", which is the question that makes revoking one safe to do. */
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** What creating one returns, exactly once.
 *
 *  `secret` appears here and in no other response in the product, because it
 *  is not stored — only its hash is. A client that does not show it to the
 *  person right now has lost it. */
export interface CreatedApiKey {
  key: ApiKeySummary;
  secret: string;
}

/** How long a label may be. Long enough for "deploy from GitHub Actions",
 *  short enough not to be a place to keep notes. */
export const MAX_KEY_LABEL = 80;

/** How many live keys one account may hold. A cap rather than none, for the
 *  same reason every other list here has one — and because an account with
 *  forty keys has lost track of them, which is the state this feature exists
 *  to keep people out of. */
export const MAX_KEYS_PER_USER = 10;
