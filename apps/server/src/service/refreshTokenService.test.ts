import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/** These exercise real rows, so they need a database.
 *
 *  Set TEST_DATABASE_URL to a throwaway Postgres with the migrations applied;
 *  CI always does. Without it the suite skips rather than failing, so a
 *  contributor with no local Postgres can still run everything else.
 */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe.skipIf(!TEST_DATABASE_URL)("refreshTokenService", () => {
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
    await prisma.refreshToken.deleteMany({});
    await prisma.user.deleteMany({});

    const user = await prisma.user.create({
      data: { email: `${Date.now()}@example.com`, passwordHash: "x" },
    });
    userId = user.id;
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

    const rows = await prisma.refreshToken.findMany();
    expect(new Set(rows.map((row) => row.familyId)).size).toBe(1);
  });

  it("rejects a token that has already been rotated", async () => {
    const first = await service.issueRefreshToken(userId);
    await service.rotateRefreshToken(first.token);

    await expect(service.rotateRefreshToken(first.token)).rejects.toThrow(
      /reused|revoked/i,
    );
  });

  it("revokes the whole family when a spent token is replayed", async () => {
    const first = await service.issueRefreshToken(userId);
    const second = await service.rotateRefreshToken(first.token);

    // The legitimate holder and a thief cannot be told apart, so both lose it.
    await expect(service.rotateRefreshToken(first.token)).rejects.toThrow();
    await expect(service.rotateRefreshToken(second.token)).rejects.toThrow();
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
    const rows = await prisma.refreshToken.findMany();

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
    const before = await prisma.refreshToken.count();

    expect(await service.pruneExpiredRefreshTokens()).toBe(0);
    expect(await prisma.refreshToken.count()).toBe(before);
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
});
