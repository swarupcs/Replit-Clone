import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import {
  DOMAIN_PATTERN,
  DOMAIN_TXT_LABEL,
  MAX_DOMAIN,
  type CustomDomain,
} from "@replit-clone/shared";
import { deployOrigin, env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import { BadRequestError, ConflictError, NotFoundError } from "../utils/errors.js";
import { assertFeature } from "./entitlementService.js";

/** A hostname the owner controls, pointed at a deployment.
 *
 *  Every generated subdomain in this product is trusted by construction: the
 *  server made it up, so nobody else has a claim on it. A custom domain
 *  inverts that. The user supplies a name the server has no reason to believe
 *  they own, and if the server believes them anyway it will happily serve one
 *  person's code at another person's address — which is not a bug in the
 *  deployment, it is a phishing site with a valid certificate.
 *
 *  So the whole of this file is one idea: a claim is not an address. A domain
 *  is stored the moment it is claimed, because the setup instructions have to
 *  be rendered from something, and it is served only after a TXT record the
 *  claimant had to put in their own zone has been seen. `resolveSite` reads
 *  `domainVerifiedAt`, never `customDomain` alone.
 *
 *  **What this file does not do.** It does not obtain a certificate. Over
 *  plain HTTP a verified domain works the moment DNS points here; over HTTPS
 *  the operator still needs a certificate for that name, which is ACME's job
 *  and a deployment decision rather than a code one. That is the half of
 *  plan.md §3.3 that is genuinely infrastructure, and it is unchanged by any
 *  of this. The half that was code is here.
 */

/** How long a verified domain may go unchecked before the sweep looks again.
 *
 *  Re-checking at all is the point. A domain can be sold, a DNS zone can be
 *  handed to somebody else, and a verification that happened once and is
 *  believed forever means the previous owner keeps an address they no longer
 *  control. Daily is far more often than a domain changes hands and far less
 *  often than anybody would notice the queries.
 */
export const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;

/** How many domains one sweep will re-check.
 *
 *  Bounded because this runs on a timer against an external resolver, and an
 *  unbounded sweep on a large deployment is a self-inflicted DNS flood that
 *  arrives every hour on the hour.
 */
const RECHECK_BATCH = 50;

/* ---- what may be claimed ---- */

/** Lowercased, trailing dot removed, and checked.
 *
 *  A hostname arrives from a form and ends up in a `Host` comparison, a
 *  certificate request and a log line. Normalising once here means the rest of
 *  the file can compare with `===` instead of each caller inventing its own
 *  idea of what two hostnames being equal means.
 */
export function normalizeDomain(raw: string): string {
  // The trailing dot is the fully-qualified form. It is legal to type, means
  // the same name, and would compare unequal to every stored value.
  const domain = raw.trim().toLowerCase().replace(/\.$/, "");

  if (domain.length === 0) {
    throw new BadRequestError("Enter a domain.", "DOMAIN_REQUIRED");
  }

  if (domain.length > MAX_DOMAIN) {
    throw new BadRequestError(
      `A hostname cannot be longer than ${String(MAX_DOMAIN)} characters.`,
      "DOMAIN_TOO_LONG",
    );
  }

  // Catches the common paste rather than leaving it to the pattern, because
  // "https://example.com/" failing as "not a valid hostname" tells somebody
  // who pasted a URL nothing about what to do next.
  if (/[/:\s]/.test(domain)) {
    throw new BadRequestError(
      "Enter just the hostname — no scheme, port or path.",
      "DOMAIN_NOT_A_HOSTNAME",
    );
  }

  if (!DOMAIN_PATTERN.test(domain)) {
    throw new BadRequestError(
      "That is not a domain name. It needs at least two labels, letters, " +
        "digits and hyphens only.",
      "DOMAIN_INVALID",
    );
  }

  return domain;
}

/** The hostnames this platform answers on itself.
 *
 *  Read at call time rather than captured at import, because the tests set
 *  origins per case and a module-level constant would freeze whichever one
 *  loaded first.
 */
function reservedHosts(): string[] {
  const hosts = [deployOrigin.hostname];

  // Wrapped because these are validated as URLs by the schema, and a future
  // relaxation there should not take the domain guard down with it.
  for (const raw of [env.WEB_ORIGIN, env.API_ORIGIN]) {
    try {
      hosts.push(new URL(raw).hostname);
    } catch {
      // An unparseable origin cannot be impersonated by name, so there is
      // nothing to reserve.
    }
  }

  return hosts.map((host) => host.toLowerCase().replace(/\.$/, ""));
}

/** Refuses names that belong to the platform rather than to any user.
 *
 *  Without this the feature hands out the platform's own namespace. A claim on
 *  the API's hostname points the deploy listener at user code under the name
 *  the browser has an session cookie for; a claim under the deploy origin's
 *  suffix collides with the generated subdomains, which are handed out on the
 *  assumption that nothing else can occupy that space.
 */
export function assertClaimable(domain: string): void {
  for (const host of reservedHosts()) {
    if (domain === host || domain.endsWith(`.${host}`)) {
      throw new BadRequestError(
        "That name belongs to this platform.",
        "DOMAIN_RESERVED",
      );
    }
  }
}

/* ---- the record to publish ---- */

/** Where the proof goes: `_replit-clone-verify.<domain>`. */
export function txtName(domain: string): string {
  return `${DOMAIN_TXT_LABEL}.${domain}`;
}

/** The row, in the shape the client reads.
 *
 *  Returns null rather than a half-filled object when no domain is claimed, so
 *  that "has a custom domain" is one check on the client instead of a rule
 *  about which fields happen to be set.
 */
export function toCustomDomain(row: {
  customDomain: string | null;
  domainToken: string | null;
  domainVerifiedAt: Date | null;
  domainCheckedAt: Date | null;
}): CustomDomain | null {
  if (!row.customDomain) return null;

  return {
    domain: row.customDomain,
    verified: row.domainVerifiedAt !== null,
    verifiedAt: row.domainVerifiedAt?.toISOString() ?? null,
    checkedAt: row.domainCheckedAt?.toISOString() ?? null,
    txtName: txtName(row.customDomain),
    txtValue: row.domainToken ?? "",
  };
}

/* ---- claiming ---- */

/** Claims a domain for a project's deployment.
 *
 *  Stored unverified, with a fresh token. Re-claiming the same domain rolls
 *  the token rather than reusing it, so a value that leaked from an old set of
 *  instructions cannot be used to satisfy a later claim.
 */
export async function claimDomain(input: {
  projectId: string;
  domain: string;
}): Promise<CustomDomain> {
  const projectId = assertValidProjectId(input.projectId);
  const domain = normalizeDomain(input.domain);
  assertClaimable(domain);

  await assertFeature(projectId, "customDomains");

  const deployment = await prisma.deployment.findUnique({
    where: { projectId },
    select: { id: true },
  });

  if (!deployment) {
    throw new NotFoundError(
      "Publish the project before pointing a domain at it.",
      "NOT_DEPLOYED",
    );
  }

  const token = randomBytes(24).toString("base64url");

  try {
    const row = await prisma.deployment.update({
      where: { projectId },
      data: {
        customDomain: domain,
        domainToken: token,
        // Both cleared: re-claiming is a new claim, and a domain that was
        // verified under a previous token must stop being served until the
        // new one is seen. Leaving these set would make re-claiming a way to
        // move a verified name onto a different token without proving
        // anything.
        domainVerifiedAt: null,
        domainCheckedAt: null,
      },
    });

    logger.info("custom domain claimed", { projectId, domain });
    return toCustomDomain(row) as CustomDomain;
  } catch (error) {
    // Same lesson as the report queue: the unique index is what is actually
    // true, and a "is it taken" read before the write loses to a concurrent
    // claim. Refusing without saying which project holds it -- somebody
    // probing for a domain learns whether it is claimed here, which they can
    // already learn from DNS.
    if (!isUniqueViolation(error)) throw error;

    throw new ConflictError(
      "That domain is already pointed at a deployment.",
      "DOMAIN_TAKEN",
    );
  }
}

/** Gives the domain up. Idempotent: releasing nothing is what a second click
 *  means, not an error. */
export async function releaseDomain(rawProjectId: string): Promise<void> {
  const projectId = assertValidProjectId(rawProjectId);

  const row = await prisma.deployment.findUnique({
    where: { projectId },
    select: { customDomain: true },
  });

  if (!row?.customDomain) return;

  await prisma.deployment.update({
    where: { projectId },
    data: {
      customDomain: null,
      domainToken: null,
      domainVerifiedAt: null,
      domainCheckedAt: null,
    },
  });

  logger.info("custom domain released", { projectId, domain: row.customDomain });
}

/* ---- verifying ---- */

/** Looks for the TXT record, and records what it found.
 *
 *  Every outcome writes `domainCheckedAt`, including the failures. That column
 *  is what the re-check sweep orders by, and a verification attempt that did
 *  not update it would be re-attempted immediately and forever.
 */
export async function verifyDomain(rawProjectId: string): Promise<CustomDomain> {
  const projectId = assertValidProjectId(rawProjectId);

  const row = await prisma.deployment.findUnique({
    where: { projectId },
    select: { customDomain: true, domainToken: true },
  });

  if (!row?.customDomain || !row.domainToken) {
    throw new NotFoundError("No domain is claimed here.", "NO_DOMAIN");
  }

  const seen = await hasToken(row.customDomain, row.domainToken);
  const now = new Date();

  const updated = await prisma.deployment.update({
    where: { projectId },
    data: {
      domainCheckedAt: now,
      // Only ever set forward on success. A failed check of an
      // already-verified domain is left to the sweep, which is the thing that
      // knows how to tell a sold domain from a resolver having a bad minute.
      ...(seen ? { domainVerifiedAt: now } : {}),
    },
  });

  if (seen) {
    increment("domain_verified");
    logger.info("custom domain verified", { projectId, domain: row.customDomain });
  }

  const result = toCustomDomain(updated) as CustomDomain;

  if (!result.verified) {
    throw new BadRequestError(
      `No matching TXT record at ${txtName(row.customDomain)} yet. DNS can ` +
        "take a few minutes to propagate; try again shortly.",
      "DOMAIN_NOT_VERIFIED",
    );
  }

  return result;
}

/** Whether the domain's verification record carries the token.
 *
 *  A lookup failure is indistinguishable from a missing record on purpose:
 *  NXDOMAIN, SERVFAIL and "no TXT records" all mean the same thing to a
 *  caller, which is that the proof is not there. Distinguishing them would
 *  only tempt somebody into treating one of them as good enough.
 */
async function hasToken(domain: string, token: string): Promise<boolean> {
  try {
    const records = await resolveTxt(txtName(domain));

    // Each record arrives as an array of strings, because a TXT record longer
    // than 255 bytes is transmitted in chunks and the resolver hands them back
    // unjoined. Joining is what makes a long token work at all.
    return records.some((chunks) => chunks.join("").trim() === token);
  } catch {
    return false;
  }
}

/* ---- serving ---- */

/** The verified deployment answering at this hostname, or undefined.
 *
 *  `domainVerifiedAt` is in the WHERE clause rather than checked afterwards,
 *  so there is no version of this function that returns an unverified site
 *  because somebody added a branch above the check.
 */
export async function resolveCustomDomain(
  rawHost: string,
): Promise<{ subdomain: string } | undefined> {
  const host = rawHost.toLowerCase().trim();
  // An IPv6 literal is bracketed and can never be a claimed domain.
  if (host.startsWith("[")) return undefined;

  const hostname = (host.split(":")[0] ?? "").replace(/\.$/, "");
  if (!hostname || !DOMAIN_PATTERN.test(hostname)) return undefined;

  const row = await prisma.deployment.findFirst({
    where: {
      customDomain: hostname,
      domainVerifiedAt: { not: null },
      deployedAt: { not: null },
      // Added with the TLS authorize endpoint, which asks this function
      // whether a hostname is worth a certificate. `resolveSite` filtered the
      // takedown and the trash itself, so this was never a hole in what gets
      // SERVED -- but a name whose project is gone is not a name to make a
      // certificate authority issue for, and now there is a caller that would
      // have. Belt and braces on the serving path, load-bearing on this one.
      project: { takenDownAt: null, deletedAt: null },
    },
    select: { subdomain: true },
  });

  return row ?? undefined;
}

/* ---- staying true ---- */

/** Re-checks verified domains whose last check has aged out.
 *
 *  Clears the verification when the record is gone, which stops the site being
 *  served at that name. That is the correct direction to fail: a domain whose
 *  owner has moved on stops answering here, rather than continuing to serve
 *  somebody else's code at a name they now control.
 *
 *  It does NOT release the claim. The row keeps the domain and its token, so
 *  an owner who broke their own DNS by accident fixes the record and presses
 *  verify, instead of discovering the platform quietly gave their name away.
 */
export async function recheckDomains(now = new Date()): Promise<{
  checked: number;
  cleared: number;
}> {
  const due = await prisma.deployment.findMany({
    where: {
      customDomain: { not: null },
      domainVerifiedAt: { not: null },
      OR: [
        { domainCheckedAt: null },
        { domainCheckedAt: { lt: new Date(now.getTime() - RECHECK_AFTER_MS) } },
      ],
    },
    orderBy: { domainCheckedAt: "asc" },
    take: RECHECK_BATCH,
    select: { id: true, projectId: true, customDomain: true, domainToken: true },
  });

  let cleared = 0;

  for (const row of due) {
    if (!row.customDomain || !row.domainToken) continue;

    const seen = await hasToken(row.customDomain, row.domainToken);

    await prisma.deployment.update({
      where: { id: row.id },
      data: {
        domainCheckedAt: new Date(),
        ...(seen ? {} : { domainVerifiedAt: null }),
      },
    });

    if (!seen) {
      cleared += 1;
      increment("domain_unverified");
      // Warn rather than info: somebody's site has just stopped answering at
      // its own address, and the operator finding that out from a support
      // ticket instead of a log line is the bad version of this.
      logger.warn("custom domain no longer verified", {
        projectId: row.projectId,
        domain: row.customDomain,
      });
    }
  }

  return { checked: due.length, cleared };
}

/** Prisma's unique-constraint failure, recognised by shape rather than by an
 *  `instanceof` against a client that is regenerated into `src/generated`. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error).code === "P2002"
  );
}
