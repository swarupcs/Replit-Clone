import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dbScope } from "../test/dbScope.js";

/** Claiming, proving and serving a custom domain, against real rows.
 *
 *  Two things here cannot be faked into meaning anything. The unique index is
 *  what actually stops two projects claiming one name — a check before the
 *  write loses to a concurrent claim, and this is the test that says so. And
 *  `resolveSite` reading `domainVerifiedAt` is the difference between a
 *  feature and a way to serve one person's code at another person's address,
 *  which is a property of a query rather than of a branch.
 *
 *  DNS is mocked, because the point is what this code does with an answer and
 *  not whether a resolver works.
 *
 *  Set TEST_DATABASE_URL to a throwaway Postgres with the migrations applied.
 */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

const resolveTxt = vi.hoisted(() => vi.fn<(name: string) => Promise<string[][]>>());

vi.mock("node:dns/promises", () => ({ resolveTxt }));

describe.skipIf(!TEST_DATABASE_URL)("custom domains", () => {
  const scope = dbScope("domains");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let domains: typeof import("./customDomainService.js");
  let deploy: typeof import("./deployService.js");

  let ownerId: string;
  let projectId: string;
  let otherProjectId: string;
  /** Unique per test, because a subdomain is unique across the database and
   *  these rows outlive nothing but their own case. */
  let tag: string;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ prisma } = await import("../lib/prisma.js"));
    domains = await import("./customDomainService.js");
    deploy = await import("./deployService.js");
  });

  beforeEach(async () => {
    tag = randomUUID().slice(0, 8);
    resolveTxt.mockReset();
    // Nothing published anywhere, unless a test says otherwise.
    resolveTxt.mockRejectedValue(
      Object.assign(new Error("queryTxt ENOTFOUND"), { code: "ENOTFOUND" }),
    );

    const owner = await prisma.user.create({
      data: { email: scope.email("owner"), passwordHash: "x" },
    });
    ownerId = owner.id;

    const one = await prisma.project.create({
      data: { name: "Site", ownerId, template: "static-html" },
    });
    const two = await prisma.project.create({
      data: { name: "Other", ownerId, template: "static-html" },
    });
    projectId = one.id;
    otherProjectId = two.id;

    // A deployment for each, live, because a domain is claimed against a
    // published project and refused against anything else.
    for (const [id, subdomain] of [
      [projectId, `rc-${tag}-one`],
      [otherProjectId, `rc-${tag}-two`],
    ] as const) {
      await prisma.deployment.create({
        data: {
          projectId: id,
          subdomain,
          status: "LIVE",
          kind: "STATIC",
          buildCommand: "",
          outputDir: ".",
          deployedAt: new Date(),
        },
      });
    }
  });

  afterEach(async () => {
    await scope.cleanup(prisma);
  });

  /** The TXT record the claimant is meant to publish, as the resolver would
   *  hand it back: one record, in chunks. */
  function publishes(token: string, chunks = [token]): void {
    resolveTxt.mockResolvedValue([chunks]);
  }

  describe("claiming", () => {
    it("stores the domain unverified, with a record to publish", async () => {
      const claim = await domains.claimDomain({
        projectId,
        domain: "WWW.Example.com.",
      });

      expect(claim.domain).toBe("www.example.com");
      // The whole point: a claim is not an address.
      expect(claim.verified).toBe(false);
      expect(claim.txtName).toBe("_replit-clone-verify.www.example.com");
      expect(claim.txtValue).toHaveLength(32);
    });

    it("will not point a domain at a project that was never published", async () => {
      const bare = await prisma.project.create({
        data: { name: "Unpublished", ownerId, template: "static-html" },
      });

      await expect(
        domains.claimDomain({ projectId: bare.id, domain: "example.com" }),
      ).rejects.toMatchObject({ statusCode: 404, code: "NOT_DEPLOYED" });
    });

    it("takes one project per domain", async () => {
      await domains.claimDomain({ projectId, domain: "example.com" });

      await expect(
        domains.claimDomain({ projectId: otherProjectId, domain: "example.com" }),
      ).rejects.toMatchObject({ statusCode: 409, code: "DOMAIN_TAKEN" });
    });

    it("takes one even when both claims arrive at once", async () => {
      // The read before the write cannot settle this: both calls can see the
      // name free before either takes it. The unique index is what actually
      // decides, and losing that race has to be a 409 rather than a 500.
      const outcomes = await Promise.allSettled([
        domains.claimDomain({ projectId, domain: "contested.example.com" }),
        domains.claimDomain({
          projectId: otherProjectId,
          domain: "contested.example.com",
        }),
      ]);

      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const [refused] = outcomes.filter((o) => o.status === "rejected");
      expect(refused).toMatchObject({
        reason: { statusCode: 409, code: "DOMAIN_TAKEN" },
      });
    });

    it("rolls the token when the same domain is re-claimed", async () => {
      const first = await domains.claimDomain({ projectId, domain: "example.com" });
      const second = await domains.claimDomain({ projectId, domain: "example.com" });

      // A token that leaked from an old set of instructions must not satisfy
      // a later claim.
      expect(second.txtValue).not.toBe(first.txtValue);
    });

    it("un-verifies a domain that is re-claimed", async () => {
      const claim = await domains.claimDomain({ projectId, domain: "example.com" });
      publishes(claim.txtValue);
      await domains.verifyDomain(projectId);

      await domains.claimDomain({ projectId, domain: "example.com" });

      const row = await prisma.deployment.findUniqueOrThrow({
        where: { projectId },
      });
      // Otherwise re-claiming is a way to move a verified name onto a new
      // token without proving anything about it.
      expect(row.domainVerifiedAt).toBeNull();
    });
  });

  describe("verifying", () => {
    it("verifies when the record carries the token", async () => {
      const claim = await domains.claimDomain({ projectId, domain: "example.com" });
      publishes(claim.txtValue);

      const verified = await domains.verifyDomain(projectId);

      expect(verified.verified).toBe(true);
      expect(verified.verifiedAt).not.toBeNull();
      expect(resolveTxt).toHaveBeenCalledWith(
        "_replit-clone-verify.example.com",
      );
    });

    it("joins a record the resolver split into chunks", async () => {
      // A TXT record over 255 bytes arrives in pieces, unjoined. Comparing
      // against the first piece is a verification that fails for long tokens
      // and nobody would know why.
      const claim = await domains.claimDomain({ projectId, domain: "example.com" });
      const half = Math.ceil(claim.txtValue.length / 2);
      publishes(claim.txtValue, [
        claim.txtValue.slice(0, half),
        claim.txtValue.slice(half),
      ]);

      await expect(domains.verifyDomain(projectId)).resolves.toMatchObject({
        verified: true,
      });
    });

    it("refuses when the record is absent, and says where to put it", async () => {
      await domains.claimDomain({ projectId, domain: "example.com" });

      await expect(domains.verifyDomain(projectId)).rejects.toMatchObject({
        statusCode: 400,
        code: "DOMAIN_NOT_VERIFIED",
      });
    });

    it("refuses somebody else's token", async () => {
      await domains.claimDomain({ projectId, domain: "example.com" });
      publishes("a-token-from-somewhere-else");

      await expect(domains.verifyDomain(projectId)).rejects.toMatchObject({
        code: "DOMAIN_NOT_VERIFIED",
      });
    });

    it("records the attempt even when it fails", async () => {
      // The sweep orders by this column. A failed check that did not write it
      // would be retried immediately and forever.
      await domains.claimDomain({ projectId, domain: "example.com" });
      await expect(domains.verifyDomain(projectId)).rejects.toThrow();

      const row = await prisma.deployment.findUniqueOrThrow({
        where: { projectId },
      });
      expect(row.domainCheckedAt).not.toBeNull();
      expect(row.domainVerifiedAt).toBeNull();
    });

    it("has nothing to verify when no domain is claimed", async () => {
      await expect(domains.verifyDomain(projectId)).rejects.toMatchObject({
        statusCode: 404,
        code: "NO_DOMAIN",
      });
    });
  });

  describe("serving", () => {
    it("does not resolve a claimed but unverified domain", async () => {
      await domains.claimDomain({ projectId, domain: "example.com" });

      // The entire feature, in one assertion. A claim the server has not
      // checked must not put anybody's code at that address.
      expect(await domains.resolveCustomDomain("example.com")).toBeUndefined();
      expect(await deploy.resolveSite("example.com")).toBeUndefined();
    });

    it("resolves a verified one to its site", async () => {
      const claim = await domains.claimDomain({ projectId, domain: "example.com" });
      publishes(claim.txtValue);
      await domains.verifyDomain(projectId);

      const site = await deploy.resolveSite("example.com");
      expect(site?.subdomain).toBe(`rc-${tag}-one`);
    });

    it("ignores the port and the trailing dot in a Host header", async () => {
      const claim = await domains.claimDomain({ projectId, domain: "example.com" });
      publishes(claim.txtValue);
      await domains.verifyDomain(projectId);

      expect(await deploy.resolveSite("example.com:8443")).toBeDefined();
      expect(await deploy.resolveSite("Example.COM.")).toBeDefined();
    });

    it("does not resolve a domain whose deployment never went live", async () => {
      const claim = await domains.claimDomain({ projectId, domain: "example.com" });
      publishes(claim.txtValue);
      await domains.verifyDomain(projectId);

      await prisma.deployment.update({
        where: { projectId },
        data: { deployedAt: null },
      });

      expect(await domains.resolveCustomDomain("example.com")).toBeUndefined();
    });

    it("stops resolving once the domain is released", async () => {
      const claim = await domains.claimDomain({ projectId, domain: "example.com" });
      publishes(claim.txtValue);
      await domains.verifyDomain(projectId);

      await domains.releaseDomain(projectId);

      expect(await deploy.resolveSite("example.com")).toBeUndefined();
    });

    it("frees the name for somebody else once released", async () => {
      await domains.claimDomain({ projectId, domain: "example.com" });
      await domains.releaseDomain(projectId);

      await expect(
        domains.claimDomain({ projectId: otherProjectId, domain: "example.com" }),
      ).resolves.toMatchObject({ domain: "example.com" });
    });
  });

  describe("staying true", () => {
    it("un-verifies a domain whose record has gone", async () => {
      const claim = await domains.claimDomain({ projectId, domain: "example.com" });
      publishes(claim.txtValue);
      await domains.verifyDomain(projectId);

      // The domain was sold, or the zone was handed to somebody else.
      resolveTxt.mockRejectedValue(new Error("queryTxt ENOTFOUND"));
      await stale(projectId);

      const swept = await domains.recheckDomains();

      expect(swept).toMatchObject({ checked: 1, cleared: 1 });
      // Stops answering here, which is the correct direction to fail.
      expect(await deploy.resolveSite("example.com")).toBeUndefined();
    });

    it("keeps the claim, so a broken record can be fixed and re-verified", async () => {
      const claim = await domains.claimDomain({ projectId, domain: "example.com" });
      publishes(claim.txtValue);
      await domains.verifyDomain(projectId);

      resolveTxt.mockRejectedValue(new Error("queryTxt ENOTFOUND"));
      await stale(projectId);
      await domains.recheckDomains();

      const row = await prisma.deployment.findUniqueOrThrow({
        where: { projectId },
      });
      // An owner who broke their own DNS fixes the record and presses verify.
      // They do not discover the platform gave their name away.
      expect(row.customDomain).toBe("example.com");
      expect(row.domainToken).toBe(claim.txtValue);

      publishes(claim.txtValue);
      await expect(domains.verifyDomain(projectId)).resolves.toMatchObject({
        verified: true,
      });
    });

    it("leaves a domain alone while its record is still there", async () => {
      const claim = await domains.claimDomain({ projectId, domain: "example.com" });
      publishes(claim.txtValue);
      await domains.verifyDomain(projectId);
      await stale(projectId);

      expect(await domains.recheckDomains()).toMatchObject({
        checked: 1,
        cleared: 0,
      });
      expect(await deploy.resolveSite("example.com")).toBeDefined();
    });

    it("does not re-check one that was looked at recently", async () => {
      const claim = await domains.claimDomain({ projectId, domain: "example.com" });
      publishes(claim.txtValue);
      await domains.verifyDomain(projectId);

      // No `stale` call: the check just happened. Sweeping every verified
      // domain every hour would be a DNS flood on the hour, every hour.
      expect(await domains.recheckDomains()).toMatchObject({ checked: 0 });
    });

    it("ignores a domain that was never verified", async () => {
      await domains.claimDomain({ projectId, domain: "example.com" });
      await stale(projectId);

      // There is nothing to take away, and nothing is being served.
      expect(await domains.recheckDomains()).toMatchObject({ checked: 0 });
    });
  });

  /** Ages a row's last check past the staleness window. */
  async function stale(id: string): Promise<void> {
    await prisma.deployment.update({
      where: { projectId: id },
      data: {
        domainCheckedAt: new Date(Date.now() - domains.RECHECK_AFTER_MS - 1000),
      },
    });
  }
});
