import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbScope } from "../test/dbScope.js";

/** §13.6 against real rows.
 *
 *  The refusals are the substance of this row — an invite that is expired,
 *  revoked, or points at a moderated project must all fail, and must fail
 *  indistinguishably. That is a question about WHERE clauses and real
 *  timestamps, which is not a question a mocked Prisma can answer.
 */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe.skipIf(!TEST_DATABASE_URL)("a pairing link", () => {
  const scope = dbScope("pairing");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let pairing: typeof import("./pairingService.js");
  let tokens: typeof import("./tokenService.js");

  let userId: string;
  let projectId: string;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ prisma } = await import("../lib/prisma.js"));
    pairing = await import("./pairingService.js");
    tokens = await import("./tokenService.js");
  });

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: { email: scope.email("owner"), passwordHash: "x" },
    });
    userId = user.id;

    const project = await prisma.project.create({
      data: { name: "paired", ownerId: userId },
    });
    projectId = project.id;
  });

  afterEach(async () => {
    await scope.cleanup(prisma);
  });

  it("lets a stranger in without creating an account or a collaborator row", async () => {
    // The whole row: the collaborative layer becomes reachable, and nothing in
    // `users` or `project_collaborators` changes.
    const invite = await pairing.createPairingInvite(projectId, userId);
    const usersBefore = await prisma.user.count();

    const redeemed = await pairing.redeemPairingInvite(invite.token, "Sam");

    expect(redeemed.projectId).toBe(projectId);
    expect(redeemed.displayName).toBe("Sam");
    expect(await prisma.user.count()).toBe(usersBefore);
    expect(await prisma.projectCollaborator.count({ where: { projectId } })).toBe(0);
  });

  it("mints a token that only works for the project it was issued for", async () => {
    const other = await prisma.project.create({
      data: { name: "elsewhere", ownerId: userId },
    });
    const invite = await pairing.createPairingInvite(projectId, userId);
    const redeemed = await pairing.redeemPairingInvite(invite.token, "Sam");
    const claims = tokens.verifyPairingToken(redeemed.token);

    expect(await pairing.pairingAccess(claims, projectId)).not.toBeNull();
    expect(await pairing.pairingAccess(claims, other.id)).toBeNull();
  });

  it("grants exactly the role the invite carried", async () => {
    const invite = await pairing.createPairingInvite(projectId, userId, {
      role: "VIEWER",
    });
    const redeemed = await pairing.redeemPairingInvite(invite.token, undefined);
    const claims = tokens.verifyPairingToken(redeemed.token);

    const access = await pairing.pairingAccess(claims, projectId);
    expect(access?.level).toBe("viewer");
  });

  it("refuses an expired link", async () => {
    const invite = await pairing.createPairingInvite(projectId, userId);
    await prisma.pairingInvite.update({
      where: { id: invite.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(pairing.redeemPairingInvite(invite.token, "Sam")).rejects.toThrow();
  });

  it("refuses a revoked link", async () => {
    const invite = await pairing.createPairingInvite(projectId, userId);
    await pairing.revokePairingInvite(projectId, invite.id);

    await expect(pairing.redeemPairingInvite(invite.token, "Sam")).rejects.toThrow();
  });

  it("refuses a link into a project a moderator took down", async () => {
    // §6 decision 13: a project taken down for MALWARE must stop handing
    // anybody a container to run it in, and a guarantee that depends on a
    // cleanup having succeeded is not a guarantee.
    const invite = await pairing.createPairingInvite(projectId, userId);
    await prisma.project.update({
      where: { id: projectId },
      data: { takenDownAt: new Date() },
    });

    await expect(pairing.redeemPairingInvite(invite.token, "Sam")).rejects.toThrow();
  });

  it("refuses a link into a trashed project", async () => {
    const invite = await pairing.createPairingInvite(projectId, userId);
    await prisma.project.update({
      where: { id: projectId },
      data: { deletedAt: new Date() },
    });

    await expect(pairing.redeemPairingInvite(invite.token, "Sam")).rejects.toThrow();
  });

  it("says the same thing however it refuses", async () => {
    // A link that says "expired" tells whoever holds it that it was once real
    // and that this project exists. The distinctions live in the metrics.
    const expired = await pairing.createPairingInvite(projectId, userId);
    await prisma.pairingInvite.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const revoked = await pairing.createPairingInvite(projectId, userId);
    await pairing.revokePairingInvite(projectId, revoked.id);

    const messages = await Promise.all(
      [expired.token, revoked.token, "never-existed"].map((token) =>
        pairing.redeemPairingInvite(token, "Sam").catch((error: unknown) =>
          error instanceof Error ? error.message : String(error),
        ),
      ),
    );

    expect(new Set(messages).size).toBe(1);
  });

  it("cannot be revoked through a project that does not own it", async () => {
    const other = await prisma.project.create({
      data: { name: "elsewhere", ownerId: userId },
    });
    const invite = await pairing.createPairingInvite(projectId, userId);

    await expect(pairing.revokePairingInvite(other.id, invite.id)).rejects.toThrow();
    // And the link still works, because nothing was revoked.
    await expect(pairing.redeemPairingInvite(invite.token, "Sam")).resolves.toBeTruthy();
  });

  it("counts redemptions, so an unused link is visibly unused", async () => {
    const invite = await pairing.createPairingInvite(projectId, userId);
    await pairing.redeemPairingInvite(invite.token, "Sam");
    await pairing.redeemPairingInvite(invite.token, "Alex");

    const [listed] = await pairing.listPairingInvites(projectId);
    expect(listed?.redeemedCount).toBe(2);
  });

  it("gives two guests different identities", async () => {
    // They appear as separate cursors, so they cannot share a `sub`.
    const invite = await pairing.createPairingInvite(projectId, userId);
    const one = await pairing.redeemPairingInvite(invite.token, "Sam");
    const two = await pairing.redeemPairingInvite(invite.token, "Alex");

    expect(one.guestId).not.toBe(two.guestId);
  });

  it("goes away with the project", async () => {
    const invite = await pairing.createPairingInvite(projectId, userId);
    await prisma.project.delete({ where: { id: projectId } });

    expect(await prisma.pairingInvite.findUnique({ where: { id: invite.id } })).toBeNull();
  });

  it("sweeps links a week after they stopped working, and no sooner", async () => {
    const recent = await pairing.createPairingInvite(projectId, userId);
    await prisma.pairingInvite.update({
      where: { id: recent.id },
      data: { expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    const ancient = await pairing.createPairingInvite(projectId, userId);
    await prisma.pairingInvite.update({
      where: { id: ancient.id },
      data: { expiresAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    });

    await pairing.sweepPairingInvites();

    // The owner's list still explains what happened yesterday.
    expect(await prisma.pairingInvite.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(await prisma.pairingInvite.findUnique({ where: { id: ancient.id } })).toBeNull();
  });
});

describe("what a guest is called", () => {
  it("keeps a name they chose", async () => {
    const { guestName } = await import("./pairingService.js");
    expect(guestName("Sam")).toBe("Sam");
  });

  it("falls back rather than rendering an empty label", async () => {
    const { guestName } = await import("./pairingService.js");
    expect(guestName(undefined)).toBe("Guest");
    expect(guestName("   ")).toBe("Guest");
  });

  it("strips control characters, which have no business beside a cursor", async () => {
    const { guestName } = await import("./pairingService.js");
    const nasty = `Sam${String.fromCharCode(0)}${String.fromCharCode(27)}[31m`;

    const cleaned = guestName(nasty);
    expect(cleaned).not.toContain(String.fromCharCode(0));
    expect(cleaned).not.toContain(String.fromCharCode(27));
    expect(cleaned.startsWith("Sam")).toBe(true);
  });

  it("bounds a name somebody else chose", async () => {
    const { guestName } = await import("./pairingService.js");
    expect(guestName("n".repeat(500)).length).toBe(40);
  });
});
