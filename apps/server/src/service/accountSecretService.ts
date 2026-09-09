import { prisma } from "../lib/prisma.js";
import { BadRequestError } from "../utils/errors.js";
import {
  envVarsSchema,
  parseEnvVars,
  sealEnvVars,
  type EnvVars,
} from "./projectEnvService.js";

/** Variables that belong to a person rather than to a project. plan.md §13.8.
 *
 *  **What was wrong.** `envVars` appeared exactly once in the schema, on
 *  `projects`. So one person with one `ANTHROPIC_API_KEY`, one `NPM_TOKEN` and
 *  one database URL typed all three into every workspace they created, and
 *  rotating any of them meant editing every project by hand — which is the
 *  version of "rotate a key" that does not happen.
 *
 *  **What this is not.** Not a second sealing scheme, not a second validator,
 *  and not a second answer to "is this column encrypted": names, limits and
 *  sealing all come from `projectEnvService`, which already decided every one
 *  of those questions. This module is a second SCOPE for that same shape, and
 *  the merge order is the only new decision in it.
 *
 *  **The merge order, weakest first:** account, then the managed database's
 *  URL, then the project's own. An account value is the least specific thing
 *  anybody said; a project value is somebody choosing for this project, and it
 *  wins. Where a name is set in both, nothing warns — the panel shows which
 *  ones are shadowed instead, because a warning on every save for a thing
 *  somebody did on purpose is noise.
 *
 *  **Who can read a container's environment, which is the decision that
 *  actually matters here.** These are injected into every container of every
 *  project the account OWNS, including shared ones — and an editor on a shared
 *  project can run `env` in its terminal. That is not a leak introduced here;
 *  it is what an editor already is (`getProjectEnvController` requires editor
 *  precisely because "read-only access to a project is not the same as being
 *  trusted with its credentials"). What IS new is that the blast radius of one
 *  mistake grew from one project to all of them, so the account screen says so
 *  plainly and the share dialog says it again at the moment somebody shares.
 *
 *  Rejected alternatives, recorded so they are not re-proposed as fixes:
 *  withholding account secrets from shared projects would mean adding a
 *  collaborator silently changes what a running project's container has, which
 *  breaks it at a moment nobody would connect to the cause; and per-project
 *  opt-in lists are GitHub's answer and are a materially larger feature than
 *  the row asked for.
 */

/** One account's variables, decrypted. Empty for an account with no row —
 *  which is every account that existed before this column did. */
export async function getAccountSecrets(userId: string): Promise<EnvVars> {
  const row = await prisma.userPersonalization.findUnique({
    where: { userId },
    select: { envVars: true },
  });

  return parseEnvVars(row?.envVars);
}

/** The same thing, named for what the container layer wants it for.
 *
 *  A separate export rather than an alias so the call in `getEnvVars` reads as
 *  what it is, and so this one can grow a cache or a narrower select later
 *  without the account screen's read changing with it.
 */
export async function accountEnvVars(ownerId: string): Promise<EnvVars> {
  return getAccountSecrets(ownerId);
}

export async function setAccountSecrets(
  userId: string,
  vars: unknown,
): Promise<EnvVars> {
  const parsed = envVarsSchema.safeParse(vars);

  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
      "INVALID_ENV_VARS",
    );
  }

  const sealed = sealEnvVars(parsed.data);

  // Upsert, because the row is created on first write — an account that has
  // never set dotfiles or a signing key has no row at all, and the first
  // secret is a perfectly ordinary reason for one to exist.
  await prisma.userPersonalization.upsert({
    where: { userId },
    create: { userId, envVars: sealed },
    update: { envVars: sealed },
  });

  // The plaintext the caller sent, exactly as `setEnvVars` does: they are
  // entitled to it, they just typed it, and a round trip through the column
  // would only prove the cipher works.
  return parsed.data;
}

/** Which of an account's names a project overrides.
 *
 *  For the panel, so somebody can see that the `DATABASE_URL` they set on
 *  their account is not the one this project is using. Reported rather than
 *  refused: shadowing is the merge order working, and the failure worth
 *  preventing is not knowing it happened.
 */
export function shadowedNames(
  accountVars: EnvVars,
  projectVars: EnvVars,
): string[] {
  return Object.keys(accountVars)
    .filter((name) => name in projectVars)
    .sort();
}
