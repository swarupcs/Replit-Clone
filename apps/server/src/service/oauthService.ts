import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { BadRequestError, UnauthorizedError } from "../utils/errors.js";
import { toPublicUser, type PublicUser } from "./authService.js";

/** GitHub sign-in.
 *
 *  Optional: without a client id and secret the endpoints report that it is not
 *  configured rather than failing in some more mysterious way. The audience for
 *  a browser IDE mostly has a GitHub account, which is why it is the provider
 *  worth having.
 */

export function isGithubConfigured(): boolean {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

function assertConfigured(): { clientId: string; clientSecret: string } {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new BadRequestError(
      "GitHub sign-in is not configured on this server",
      "OAUTH_NOT_CONFIGURED",
    );
  }

  return {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
  };
}

/** Where GitHub sends the browser to authorise. */
export function githubAuthorizeUrl(state: string): string {
  const { clientId } = assertConfigured();

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", `${env.API_ORIGIN}/api/v1/auth/github/callback`);
  // `user:email` because a GitHub account's primary address is often private,
  // and an account here without an email is not much of an account.
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", state);

  return url.toString();
}

interface GithubUser {
  id: number;
  login: string;
  avatar_url?: string;
  email?: string | null;
}

interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

async function exchangeCode(code: string): Promise<string> {
  const { clientId, clientSecret } = assertConfigured();

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${env.API_ORIGIN}/api/v1/auth/github/callback`,
    }),
  });

  if (!response.ok) {
    throw new UnauthorizedError("GitHub rejected the sign-in", "OAUTH_FAILED");
  }

  const body = (await response.json()) as { access_token?: string; error?: string };
  if (!body.access_token) {
    throw new UnauthorizedError("GitHub rejected the sign-in", "OAUTH_FAILED");
  }

  return body.access_token;
}

async function fetchGithub<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "replit-clone",
    },
  });

  if (!response.ok) {
    throw new UnauthorizedError("Could not read your GitHub profile", "OAUTH_FAILED");
  }

  return (await response.json()) as T;
}

/** Signs in, linking to an existing account by email or creating a new one. */
export async function signInWithGithub(code: string): Promise<PublicUser> {
  const token = await exchangeCode(code);

  const profile = await fetchGithub<GithubUser>("/user", token);
  const githubId = String(profile.id);

  const existing = await prisma.user.findUnique({ where: { githubId } });
  if (existing) {
    return toPublicUser(existing);
  }

  const email = await resolveEmail(profile, token);

  // Linked by email when an account already exists, rather than creating a
  // second one: someone who signed up with a password and later uses GitHub
  // means to reach the same projects, not to start over.
  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      githubId,
      avatarUrl: profile.avatar_url,
      // GitHub has already confirmed the address; asking the user to confirm
      // it again would be theatre.
      emailVerifiedAt: new Date(),
    },
    update: { githubId, avatarUrl: profile.avatar_url },
  });

  return toPublicUser(user);
}

/** Picks the address to link this account by.
 *
 *  Accounts are matched to existing ones BY EMAIL, so which address is chosen
 *  decides which account a GitHub sign-in joins. Every path to it therefore has
 *  to be one GitHub has confirmed the person controls.
 *
 *  The profile's public email used to be taken as-is, skipping the check the
 *  fallback below performs — a weaker rule on the path that actually decided
 *  the outcome. It is now looked up in the verified list like any other.
 */
async function resolveEmail(profile: GithubUser, token: string): Promise<string> {
  const emails = await fetchGithub<GithubEmail[]>("/user/emails", token);
  const verified = emails.filter((entry) => entry.verified);

  const profileEmail = profile.email?.toLowerCase();
  const confirmedProfileEmail = profileEmail
    ? verified.find((entry) => entry.email.toLowerCase() === profileEmail)
    : undefined;

  // Their public address when GitHub confirms it, then their primary, then any
  // confirmed one — primary because that is the address the person actually
  // uses.
  const chosen =
    confirmedProfileEmail ??
    verified.find((entry) => entry.primary) ??
    verified[0];

  if (!chosen) {
    throw new UnauthorizedError(
      "Your GitHub account has no verified email address",
      "OAUTH_NO_EMAIL",
    );
  }

  return chosen.email.toLowerCase();
}
