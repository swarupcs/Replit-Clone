import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { PERSONAL_PLAN_ID } from "@replit-clone/shared";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { ForbiddenError } from "../utils/errors.js";

/** One account, provisioned from the environment.
 *
 *  Signup, email verification, password reset, refresh-token rotation with a
 *  reuse grace window, and GitHub sign-in are all correct for a deployment
 *  strangers can reach. For one person on their own machine they are ceremony
 *  in front of a text editor, and the account-recovery half of them is ceremony
 *  that depends on an outbound mail path a personal deployment usually does not
 *  have — so "forgot password" is not merely tedious there, it is a dead end.
 *
 *  What this does NOT do is delete any of it. §10.3 asked for one documented
 *  mode, as configuration, and the mode is: the account exists because the
 *  environment says so, and the routes that would make a second one are not
 *  mounted.
 *
 *  **Not mounted, rather than refusing.** A mode flag checked inside each
 *  controller is a rule that usually holds — the next route somebody adds does
 *  not know to ask. §6 decision 17 prefers exactly this shape for an API key's
 *  surface: default-deny that is structural rather than enforced. The creation
 *  boundary below is the belt to that pair of braces, and it sits where §6
 *  decision 16 says a limit belongs: at the point the thing is CREATED.
 */

/** Whether this deployment has one account by configuration. */
export function singleUserEnabled(): boolean {
  return env.SINGLE_USER_EMAIL.length > 0;
}

/** That account's address, or null when this is an ordinary deployment. */
export function singleUserEmail(): string | null {
  return singleUserEnabled() ? env.SINGLE_USER_EMAIL : null;
}

/** Refuses to create an account when this deployment has exactly one.
 *
 *  Always refuses when the mode is on, including for the configured address:
 *  that account is provisioned at boot, so a request that reaches here is
 *  either a second account or a race with the boot that made the first. Neither
 *  is something to allow, and "the email matches, so let it through" would be a
 *  second way to create the one account with different rules from the first.
 *
 *  Called from the two places that make a `User` row — `registerUser` and the
 *  GitHub sign-in upsert — because those are the two, and decision 16's rule is
 *  that a limit is checked where the thing is created and nowhere else.
 */
export function assertCanCreateAccount(): void {
  if (!singleUserEnabled()) return;

  throw new ForbiddenError(
    "This deployment is configured for a single account, which already exists.",
    "SINGLE_USER_MODE",
  );
}

/** The plan this account belongs on, if the row exists.
 *
 *  §10.4's half of this: every per-account limit rations a shared VM between
 *  tenants, and there is nobody here to ration against. The `personal` plan
 *  sets each of them to `UNLIMITED`, and leaves every limit that is about the
 *  MACHINE — `CONTAINER_MEMORY_MB`, `MAX_CONCURRENT_CONTAINERS`,
 *  `DEPLOY_MEMORY_MB` — exactly where §6 decision 15 put them.
 *
 *  Empty when the row is missing rather than failing: a deployment whose
 *  migrations have not caught up should get its account, on whatever plan it
 *  has, rather than no account at all. `resolveEntitlements` already falls back
 *  to the free plan's numbers for the same reason.
 */
async function personalPlan(): Promise<{ planId?: string }> {
  // try/catch and not `.catch()`: this has to survive the lookup THROWING as
  // well as rejecting, and a synchronous throw happens before there is a
  // promise to attach a handler to. That is not hypothetical -- it is what a
  // client generated before this plan existed does.
  let plan: { id: string } | null = null;
  try {
    plan = await prisma.plan.findUnique({
      where: { id: PERSONAL_PLAN_ID },
      select: { id: true },
    });
  } catch {
    plan = null;
  }

  if (!plan) {
    logger.warn(
      "single-user mode: no `personal` plan row, leaving the account's plan alone",
    );
    return {};
  }

  return { planId: PERSONAL_PLAN_ID };
}

/** A password nobody chose, for a first boot with none configured.
 *
 *  32 bytes of base64url. An account with no password cannot be signed in to,
 *  and the alternative — leaving `passwordHash` null and letting anybody in —
 *  is an unauthenticated server on whatever network it can be reached from.
 */
function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

/** Makes sure the one account exists, and that its password is the configured
 *  one.
 *
 *  Runs at every boot, and is deliberately idempotent in a specific way: the
 *  password is REWRITTEN each time when `SINGLE_USER_PASSWORD` is set. That is
 *  the whole recovery story for a mode with no reset route — a forgotten
 *  password is fixed by editing the environment and restarting, which is
 *  something the one person who runs this can always do and which needs no mail
 *  server, no token table and no inbox.
 *
 *  The address is marked verified on creation. There is nothing to verify: the
 *  operator wrote it into the configuration, and asking them to confirm an
 *  address they just typed into their own server would be theatre of the kind
 *  the GitHub path already refuses to perform.
 *
 *  Never throws at a caller. A boot that cannot reach the database should fail
 *  on the database, and an account that could not be provisioned is reported
 *  loudly and left for the next boot rather than taking the process down —
 *  because the most likely cause is a database that is not up yet, and a crash
 *  loop is a worse answer than a log line and a retry.
 */
export async function ensureSingleUser(): Promise<void> {
  const email = singleUserEmail();
  if (!email) return;

  try {
    const existing = await prisma.user.findUnique({ where: { email } });

    // Configured wins. An empty value on a later boot leaves whatever password
    // the account already has, so the variable can be removed from the
    // environment once it has been used rather than living there forever.
    const configured = env.SINGLE_USER_PASSWORD;

    if (existing) {
      if (!configured) {
        // Still worth a write when the plan is wrong -- an account that
        // predates this mode is on `free`, and its owner would meet a
        // twenty-project limit on their own machine with no way to see why.
        const plan = await personalPlan();
        if (plan.planId && existing.planId !== plan.planId) {
          await prisma.user.update({ where: { id: existing.id }, data: plan });
        }

        logger.info("single-user mode: account ready", { email });
        return;
      }

      await prisma.user.update({
        where: { id: existing.id },
        data: {
          passwordHash: await argon2.hash(configured, { type: argon2.argon2id }),
          // In case the account predates this mode and was never confirmed:
          // there is no verification route mounted to confirm it with.
          emailVerifiedAt: existing.emailVerifiedAt ?? new Date(),
          ...(await personalPlan()),
        },
      });

      logger.info("single-user mode: password set from the environment", {
        email,
      });
      return;
    }

    const password = configured || generatePassword();

    await prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        emailVerifiedAt: new Date(),
        ...(await personalPlan()),
      },
    });

    if (configured) {
      logger.info("single-user mode: account created", { email });
    } else {
      // Once, at creation, and only for a password this process invented. The
      // alternative is an account that exists and cannot be used, on a machine
      // whose owner is the only person who can read this log.
      logger.warn(
        "single-user mode: created an account with a generated password. " +
          "Sign in with it, or set SINGLE_USER_PASSWORD and restart.",
        { email, password },
      );
    }
  } catch (error) {
    logger.error("single-user mode: could not provision the account", error, {
      email,
    });
  }
}
