import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { isSecretBoxConfigured, open, seal } from "../lib/secretBox.js";
import { BadRequestError, UnauthorizedError } from "../utils/errors.js";

/** Acting on GitHub as the signed-in user.
 *
 *  Distinct from `oauthService.ts`, which signs people IN. That flow asks for
 *  `read:user user:email` and drops the token the moment it has read the
 *  profile — correct for what it does, and useless for anything else.
 *
 *  This is the second, separate consent: `repo`, kept, and spent on the user's
 *  behalf. Nobody is made to grant write access to their private repositories
 *  in order to log in.
 */

/** What connecting asks for.
 *
 *  `repo` and not something narrower because GitHub's classic OAuth scopes have
 *  nothing between "public repositories" and "everything": there is no read-
 *  only-private and no per-repository grant. A GitHub App would offer both and
 *  is the better long-term answer; it is also a heavier setup for a self-hosted
 *  install, so it is noted in the plan rather than assumed here.
 */
export const CONNECT_SCOPES = "repo read:user";

export interface GithubConnectionInfo {
  login: string;
  scopes: string[];
  connectedAt: Date;
  /** Whether what GitHub granted actually covers repositories. An organisation
   *  can withhold `repo`, and the app should say so rather than failing later
   *  at an API call the user cannot connect to the cause. */
  canUseRepos: boolean;
}

/** Whether this server can offer the feature at all: it needs an OAuth app to
 *  ask with, and a key to keep the answer under. */
export function isGithubReposConfigured(): boolean {
  return Boolean(
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && isSecretBoxConfigured(),
  );
}

function assertConfigured(): { clientId: string; clientSecret: string } {
  if (!isGithubReposConfigured()) {
    throw new BadRequestError(
      "GitHub repositories are not configured on this server",
      "GITHUB_NOT_CONFIGURED",
    );
  }

  return {
    clientId: env.GITHUB_CLIENT_ID ?? "",
    clientSecret: env.GITHUB_CLIENT_SECRET ?? "",
  };
}

export function connectRedirectUri(): string {
  return `${env.API_ORIGIN}/api/v1/github/callback`;
}

/** Where the browser goes to grant repository access. */
export function connectAuthorizeUrl(state: string): string {
  const { clientId } = assertConfigured();

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", connectRedirectUri());
  url.searchParams.set("scope", CONNECT_SCOPES);
  url.searchParams.set("state", state);

  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function exchangeCode(
  code: string,
): Promise<{ token: string; scopes: string[] }> {
  const { clientId, clientSecret } = assertConfigured();

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: connectRedirectUri(),
    }),
  });

  if (!response.ok) {
    throw new UnauthorizedError("GitHub rejected the request", "GITHUB_FAILED");
  }

  const body = (await response.json()) as TokenResponse;
  if (!body.access_token) {
    throw new UnauthorizedError("GitHub rejected the request", "GITHUB_FAILED");
  }

  return {
    token: body.access_token,
    // GitHub returns them comma-separated, sometimes with spaces.
    scopes: (body.scope ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  };
}

/** A GitHub API call as some user.
 *
 *  Exported because every later phase — listing repositories, opening a pull
 *  request — is one of these, and they should share the headers, the error
 *  mapping and the one place a token is ever put in an Authorization header.
 */
export async function githubApi<T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ data: T; headers: Headers }> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "replit-clone",
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  if (response.status === 401) {
    // The stored token no longer works — revoked on GitHub, or the password
    // changed. Saying so lets the app offer reconnecting instead of showing a
    // generic failure the user cannot act on.
    throw new UnauthorizedError(
      "Your GitHub connection is no longer valid. Reconnect to continue.",
      "GITHUB_REAUTH_REQUIRED",
    );
  }

  if (!response.ok) {
    // GitHub's own message is the useful part — "Repository creation failed",
    // "Validation Failed" with a reason — so it is passed through rather than
    // replaced with something vaguer.
    const detail = (await response
      .json()
      .catch(() => null)) as { message?: string } | null;

    throw new BadRequestError(
      detail?.message ?? `GitHub returned ${String(response.status)}`,
      "GITHUB_ERROR",
    );
  }

  // 204 No Content has no body to parse.
  const data =
    response.status === 204 ? (undefined as T) : ((await response.json()) as T);

  return { data, headers: response.headers };
}

/** Completes the connect flow: exchanges the code, checks who it belongs to,
 *  and stores it encrypted. */
export async function connectGithub(
  userId: string,
  code: string,
): Promise<GithubConnectionInfo> {
  const { token, scopes } = await exchangeCode(code);

  const { data: profile } = await githubApi<{ login: string; id: number }>(
    token,
    "/user",
  );

  const connection = await prisma.githubConnection.upsert({
    where: { userId },
    create: {
      userId,
      tokenCipher: seal(token),
      scopes: scopes.join(","),
      login: profile.login,
    },
    // Reconnecting replaces the token rather than adding a second one: the old
    // one is superseded and keeping it would only be another thing to leak.
    update: {
      tokenCipher: seal(token),
      scopes: scopes.join(","),
      login: profile.login,
    },
  });

  return describe(connection);
}

interface StoredConnection {
  login: string;
  scopes: string;
  tokenCipher: string;
  createdAt: Date;
}

function describe(connection: StoredConnection): GithubConnectionInfo {
  const scopes = connection.scopes.split(",").filter(Boolean);

  return {
    login: connection.login,
    scopes,
    connectedAt: connection.createdAt,
    canUseRepos: scopes.includes("repo"),
  };
}

/** What the app should show about the connection. Never the token. */
export async function githubConnection(
  userId: string,
): Promise<GithubConnectionInfo | null> {
  const connection = await prisma.githubConnection.findUnique({
    where: { userId },
  });

  return connection ? describe(connection) : null;
}

/** The token itself, for a server-side call.
 *
 *  Deliberately a different function from `githubConnection`, and named for
 *  what it hands over: a caller that only needs to show the login should not
 *  be able to reach the credential by accident.
 */
export async function githubToken(userId: string): Promise<string> {
  const connection = await prisma.githubConnection.findUnique({
    where: { userId },
  });

  if (!connection) {
    throw new BadRequestError(
      "Connect your GitHub account first.",
      "GITHUB_NOT_CONNECTED",
    );
  }

  try {
    return open(connection.tokenCipher);
  } catch {
    // The key rotated, or the row was written under a different one. The
    // stored value is unusable, so it is dropped rather than left to fail on
    // every future call.
    await prisma.githubConnection.delete({ where: { userId } }).catch(() => {});

    throw new BadRequestError(
      "Your stored GitHub connection could not be read. Connect again.",
      "GITHUB_NOT_CONNECTED",
    );
  }
}

/** Forgets the connection. Deleted, not flagged: disconnecting should mean the
 *  credential is gone from this server. */
export async function disconnectGithub(userId: string): Promise<void> {
  await prisma.githubConnection.deleteMany({ where: { userId } });
}
