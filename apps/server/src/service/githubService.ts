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
 *  install, so it is not assumed here.
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

/** A repository, reduced to what a picker needs.
 *
 *  GitHub's own object is about a hundred fields; passing it through would put
 *  a great deal of somebody's account into a response for no reason.
 */
export interface GithubRepo {
  id: number;
  /** "owner/name", which is how people refer to one. */
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  /** Kilobytes, as GitHub reports it. Used to refuse an import that cannot fit
   *  before it is attempted rather than after. */
  sizeKb: number;
  language: string | null;
  pushedAt: string | null;
}

interface RawRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  description: string | null;
  default_branch: string;
  size: number;
  language: string | null;
  pushed_at: string | null;
}

function toRepo(raw: RawRepo): GithubRepo {
  return {
    id: raw.id,
    fullName: raw.full_name,
    owner: raw.owner.login,
    name: raw.name,
    private: raw.private,
    description: raw.description,
    defaultBranch: raw.default_branch,
    sizeKb: raw.size,
    language: raw.language,
    pushedAt: raw.pushed_at,
  };
}

/** How many repositories one page asks GitHub for. */
const PAGE_SIZE = 30;

/** The caller's repositories, most recently pushed first.
 *
 *  Two different endpoints, because GitHub has no way to search *your* private
 *  repositories through `/user/repos`, and no way to list them all through the
 *  search API without a query:
 *
 *  - no query: `/user/repos`, which includes every repository the user can push
 *    to, private ones included, ordered by push date.
 *  - a query: the search API, scoped to the user with `user:@me`, which is the
 *    only thing that filters server-side. Filtering a page client-side would
 *    search the thirty repositories that happened to load, which looks like
 *    search and is not.
 */
export async function listRepos(
  userId: string,
  { query, page = 1 }: { query?: string; page?: number } = {},
): Promise<{ repos: GithubRepo[]; hasMore: boolean }> {
  const token = await githubToken(userId);
  const trimmed = query?.trim();

  if (trimmed) {
    const search = new URLSearchParams({
      q: `${trimmed} user:@me fork:true`,
      per_page: String(PAGE_SIZE),
      page: String(page),
    });

    const { data } = await githubApi<{ items: RawRepo[]; total_count: number }>(
      token,
      `/search/repositories?${search.toString()}`,
    );

    return {
      repos: data.items.map(toRepo),
      hasMore: data.total_count > page * PAGE_SIZE,
    };
  }

  const params = new URLSearchParams({
    sort: "pushed",
    // `affiliation` rather than the default: the default includes repositories
    // the user can only read, which cannot be pushed to and would be a
    // frustrating thing to import.
    affiliation: "owner,collaborator,organization_member",
    per_page: String(PAGE_SIZE),
    page: String(page),
  });

  const { data } = await githubApi<RawRepo[]>(
    token,
    `/user/repos?${params.toString()}`,
  );

  return {
    // A full page might be the last one; the picker asks for the next and gets
    // an empty answer, which is cheaper than a count GitHub does not give here.
    repos: data.map(toRepo),
    hasMore: data.length === PAGE_SIZE,
  };
}

/** One repository, by name.
 *
 *  Asked for before an import rather than trusting what the browser sent: the
 *  default branch and the size have to come from GitHub, and this is also what
 *  establishes that the caller can actually see the repository.
 */
export async function getRepo(
  userId: string,
  owner: string,
  name: string,
): Promise<GithubRepo> {
  const token = await githubToken(userId);

  const { data } = await githubApi<RawRepo>(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  );

  return toRepo(data);
}

/** A pull request, reduced to what the panel shows. */
export interface GithubPullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  head: string;
  base: string;
}

interface RawPull {
  number: number;
  title: string;
  html_url: string;
  state: string;
  draft?: boolean;
  head: { ref: string };
  base: { ref: string };
}

function toPull(raw: RawPull): GithubPullRequest {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.html_url,
    state: raw.state,
    draft: raw.draft ?? false,
    head: raw.head.ref,
    base: raw.base.ref,
  };
}

/** Open pull requests for a branch.
 *
 *  Asked before offering to open one, so the panel can point at the existing
 *  request instead of failing on a second attempt with GitHub's "A pull request
 *  already exists" — which is true, unhelpful, and not where the user would
 *  look for the link.
 */
export async function listPullRequests(
  userId: string,
  owner: string,
  repo: string,
  head?: string,
): Promise<GithubPullRequest[]> {
  const token = await githubToken(userId);

  const params = new URLSearchParams({ state: "open", per_page: "20" });
  // GitHub wants the head qualified by owner; unqualified it silently matches
  // nothing, which would look like "no PR exists" for a branch that has one.
  if (head) params.set("head", `${owner}:${head}`);

  const { data } = await githubApi<RawPull[]>(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${params.toString()}`,
  );

  return data.map(toPull);
}

/** Opens a pull request. */
export async function createPullRequest(
  userId: string,
  input: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body?: string;
    draft?: boolean;
  },
): Promise<GithubPullRequest> {
  const token = await githubToken(userId);

  const { data } = await githubApi<RawPull>(
    token,
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`,
    {
      method: "POST",
      body: {
        title: input.title,
        head: input.head,
        base: input.base,
        ...(input.body ? { body: input.body } : {}),
        ...(input.draft ? { draft: true } : {}),
      },
    },
  );

  return toPull(data);
}

/** Pulls "owner/repo" out of a git remote URL, when it is a GitHub one.
 *
 *  Pure, and exported for its own sake: the parsing is the part with cases in
 *  it, and it needs no network to exercise. Null for anything that is not
 *  GitHub, which is how the panel knows not to offer a pull request at all.
 *
 *  Handles the three shapes a remote is written in — https, ssh, and git's
 *  scp-like syntax — because all three are what people actually have.
 */
export function parseGithubRemote(
  url: string,
): { owner: string; repo: string } | null {
  const trimmed = url.trim();

  const patterns = [
    // https://github.com/owner/repo(.git)
    /^https?:\/\/(?:[^@/]*@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    // ssh://git@github.com/owner/repo(.git)
    /^ssh:\/\/(?:[^@/]*@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    // git@github.com:owner/repo(.git) — scp-like, and the most common by far
    /^[^@\s]+@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    const owner = match?.[1];
    const repo = match?.[2];

    // A path of the right shape but empty on either side is not a repository.
    if (owner && repo) return { owner, repo };
  }

  return null;
}
