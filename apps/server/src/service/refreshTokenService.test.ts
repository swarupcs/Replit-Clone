import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbScope } from "../test/dbScope.js";

/** These exercise real rows, so they need a database.
 *
 *  Set TEST_DATABASE_URL to a throwaway Postgres with the migrations applied;
 *  CI always does. Without it the suite skips rather than failing, so a
 *  contributor with no local Postgres can still run everything else.
 */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe.skipIf(!TEST_DATABASE_URL)("refreshTokenService", () => {
  const scope = dbScope("refresh-tokens");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let service: typeof import("./refreshTokenService.js");
  let signRefreshToken: typeof import("./tokenService.js").signRefreshToken;
  let userId: string;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;

    ({ prisma } = await import("../lib/prisma.js"));
    service = await import("./refreshTokenService.js");
    ({ signRefreshToken } = await import("./tokenService.js"));
  });

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: { email: scope.email(), passwordHash: "x" },
    });
    userId = user.id;
  });

  afterEach(async () => {
    // Only this suite's rows; refresh tokens cascade from the user.
    await scope.cleanup(prisma);
  });

  it("mints a distinct token every time", () => {
    // Without a random id the payload is only a subject, a type and
    // second-granularity timestamps, so two tokens issued in the same second
    // are identical — and the store, keyed on their hash, rejects the second.
    const tokens = new Set(
      Array.from({ length: 20 }, () => signRefreshToken(userId)),
    );

    expect(tokens.size).toBe(20);
  });

  it("survives a long chain of rapid rotations", async () => {
    let token = (await service.issueRefreshToken(userId)).token;

    for (let i = 0; i < 25; i += 1) {
      token = (await service.rotateRefreshToken(token)).token;
    }

    await expect(service.rotateRefreshToken(token)).resolves.toBeDefined();
  });

  it("returns a new token and keeps the family", async () => {
    const first = await service.issueRefreshToken(userId);
    const second = await service.rotateRefreshToken(first.token);

    expect(second.userId).toBe(userId);
    expect(second.token).not.toBe(first.token);

    const rows = await prisma.refreshToken.findMany({ where: { userId } });
    expect(new Set(rows.map((row) => row.familyId)).size).toBe(1);
  });

  it("rejects a token that was rotated long enough ago to be a replay", async () => {
    const first = await service.issueRefreshToken(userId);
    await service.rotateRefreshToken(first.token);

    // Backdated past the window that exists for a second tab arriving late.
    await prisma.refreshToken.updateMany({
      where: { tokenHash: { not: undefined }, revokedAt: { not: null } },
      data: { revokedAt: new Date(Date.now() - 60_000) },
    });

    await expect(service.rotateRefreshToken(first.token)).rejects.toThrow(
      /reused|revoked/i,
    );
  });

  it("revokes the whole family when a spent token is replayed", async () => {
    const first = await service.issueRefreshToken(userId);
    const second = await service.rotateRefreshToken(first.token);

    await prisma.refreshToken.updateMany({
      where: { revokedAt: { not: null } },
      data: { revokedAt: new Date(Date.now() - 60_000) },
    });

    // The legitimate holder and a thief cannot be told apart, so both lose it.
    await expect(service.rotateRefreshToken(first.token)).rejects.toThrow();
    await expect(service.rotateRefreshToken(second.token)).rejects.toThrow();
  });

  it("rejects a replay at once when the session is already over", async () => {
    // The grace window is for a session that is genuinely still running. Once
    // it is not — signed out, family revoked — there is nothing to be late
    // for, and waiting out a timer before saying so would be a hole.
    const first = await service.issueRefreshToken(userId);
    const second = await service.rotateRefreshToken(first.token);

    await service.revokeRefreshToken(second.token);

    // No backdating: this is refused on the spot.
    await expect(service.rotateRefreshToken(first.token)).rejects.toThrow(
      /reused|revoked/i,
    );
  });

  it("makes signing out actually end the session", async () => {
    const issued = await service.issueRefreshToken(userId);
    await service.revokeRefreshToken(issued.token);

    await expect(service.rotateRefreshToken(issued.token)).rejects.toThrow();
  });

  it("refuses a correctly signed token that was never issued", async () => {
    await expect(service.rotateRefreshToken(signRefreshToken(userId))).rejects.toThrow(
      /no longer valid/i,
    );
  });

  it("never stores the token itself", async () => {
    const issued = await service.issueRefreshToken(userId);
    const rows = await prisma.refreshToken.findMany({ where: { userId } });

    for (const row of rows) {
      expect(row.tokenHash).not.toBe(issued.token);
      expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("ends every session for a user on request", async () => {
    const a = await service.issueRefreshToken(userId);
    const b = await service.issueRefreshToken(userId);

    await service.revokeAllForUser(userId);

    await expect(service.rotateRefreshToken(a.token)).rejects.toThrow();
    await expect(service.rotateRefreshToken(b.token)).rejects.toThrow();
  });

  it("leaves live rows alone when pruning", async () => {
    await service.issueRefreshToken(userId);
    const before = await prisma.refreshToken.count({ where: { userId } });

    expect(await service.pruneExpiredRefreshTokens()).toBe(0);
    expect(await prisma.refreshToken.count({ where: { userId } })).toBe(before);
  });

  it("clears rows that are long past expiry", async () => {
    const issued = await service.issueRefreshToken(userId);

    // Older than the replay grace period, so it can no longer catch anything.
    await prisma.refreshToken.updateMany({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    });

    expect(await service.pruneExpiredRefreshTokens()).toBeGreaterThan(0);
    await expect(service.rotateRefreshToken(issued.token)).rejects.toThrow();
  });

  describe("two tabs refreshing at once", () => {
    /** The defect: each tab holds its own in-flight guard, so two whose access
     *  tokens expire together both present the same cookie. The second looked
     *  exactly like a replay, the family was revoked, and the user was signed
     *  out of everything for leaving a second tab open. */
    it("does not revoke the family when the same token is presented twice", async () => {
      const { token } = await service.issueRefreshToken(userId);

      const first = await service.rotateRefreshToken(token);
      const second = await service.rotateRefreshToken(token);

      // Both tabs get a working session, and they are not the same token.
      expect(first.token).not.toBe(second.token);
      expect(first.userId).toBe(userId);

      // Crucially, the successors still work — the family survived.
      await expect(service.rotateRefreshToken(first.token)).resolves.toBeTruthy();
      await expect(service.rotateRefreshToken(second.token)).resolves.toBeTruthy();
    });

    it("still revokes the family for a replay after the grace has passed", async () => {
      const { token } = await service.issueRefreshToken(userId);
      const next = await service.rotateRefreshToken(token);

      // Backdate the spent row past the window, which is what an attacker
      // turning up later with a captured value looks like.
      await prisma.refreshToken.updateMany({
        where: { userId },
        data: { revokedAt: new Date(Date.now() - 60_000) },
      });

      await expect(service.rotateRefreshToken(token)).rejects.toThrow(/reused/i);

      // And the whole family went with it.
      await expect(service.rotateRefreshToken(next.token)).rejects.toThrow();
    });

    it("lets exactly one of several concurrent refreshes claim the row", async () => {
      const { token } = await service.issueRefreshToken(userId);

      // Fired together, the way a burst of 401s does.
      const results = await Promise.all(
        Array.from({ length: 5 }, () => service.rotateRefreshToken(token)),
      );

      const issued = new Set(results.map((result) => result.token));
      expect(issued.size).toBe(5);

      // One row spent, five successors, one family — and no revocation, since
      // the read-then-write version let several callers all believe they were
      // the first.
      const live = await prisma.refreshToken.count({
        where: { userId, revokedAt: null },
      });
      expect(live).toBe(5);
    });
  });
});
