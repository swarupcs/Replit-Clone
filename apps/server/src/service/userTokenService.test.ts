import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbScope } from "../test/dbScope.js";

/** One-time tokens gate password reset, so they are exercised against real
 *  rows. Set TEST_DATABASE_URL to a throwaway Postgres; CI always does. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe.skipIf(!TEST_DATABASE_URL)("user tokens", () => {
  const scope = dbScope("user-tokens");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let service: typeof import("./userTokenService.js");
  let userId: string;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ prisma } = await import("../lib/prisma.js"));
    service = await import("./userTokenService.js");
  });

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: { email: scope.email(), passwordHash: "x" },
    });
    userId = user.id;
  });

  afterEach(async () => {
    await scope.cleanup(prisma);
  });

  const reset = () => service.UserTokenPurpose.PASSWORD_RESET;
  const verify = () => service.UserTokenPurpose.EMAIL_VERIFICATION;

  it("mints a token unguessable enough to be a credential", async () => {
    const token = await service.issueUserToken(userId, reset());
    expect(token.length).toBeGreaterThanOrEqual(40);
  });

  it("stores only a hash, never the token itself", async () => {
    const token = await service.issueUserToken(userId, reset());
    const rows = await prisma.userToken.findMany({ where: { userId } });

    for (const row of rows) {
      expect(row.tokenHash).not.toBe(token);
      expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("consumes to the user it was issued for", async () => {
    const token = await service.issueUserToken(userId, reset());
    expect(await service.consumeUserToken(token, reset())).toBe(userId);
  });

  it("cannot be used twice", async () => {
    const token = await service.issueUserToken(userId, reset());
    await service.consumeUserToken(token, reset());

    await expect(service.consumeUserToken(token, reset())).rejects.toThrow();
  });

  it("will not be accepted for a different purpose", async () => {
    // A reset link must not double as a verification link, or the weaker flow
    // becomes a way into the stronger one.
    const token = await service.issueUserToken(userId, reset());

    await expect(service.consumeUserToken(token, verify())).rejects.toThrow();
    // And rejecting it must not have spent it.
    expect(await service.consumeUserToken(token, reset())).toBe(userId);
  });

  it("supersedes an earlier token for the same purpose", async () => {
    // Two live reset links for one account is one more than anyone needs.
    const older = await service.issueUserToken(userId, reset());
    const newer = await service.issueUserToken(userId, reset());

    await expect(service.consumeUserToken(older, reset())).rejects.toThrow();
    expect(await service.consumeUserToken(newer, reset())).toBe(userId);
  });

  it("leaves a token for another purpose alone", async () => {
    const verification = await service.issueUserToken(userId, verify());
    await service.issueUserToken(userId, reset());

    expect(await service.consumeUserToken(verification, verify())).toBe(userId);
  });

  it("refuses an expired token", async () => {
    const token = await service.issueUserToken(userId, verify());
    await prisma.userToken.updateMany({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(service.consumeUserToken(token, verify())).rejects.toThrow();
  });

  it("refuses a token that was never issued", async () => {
    await expect(
      service.consumeUserToken("not-a-real-token", reset()),
    ).rejects.toThrow();
  });

  it("reports every failure the same way", async () => {
    // Which of "never existed", "already used" and "expired" applies is not
    // something a stranger should be able to learn.
    const used = await service.issueUserToken(userId, reset());
    await service.consumeUserToken(used, reset());

    const messages: string[] = [];
    for (const candidate of [used, "never-existed"]) {
      await service.consumeUserToken(candidate, reset()).catch((error: Error) => {
        messages.push(error.message);
      });
    }

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(messages[1]);
  });

  it("prunes tokens that can no longer be used", async () => {
    await service.issueUserToken(userId, reset());
    await prisma.userToken.updateMany({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await service.pruneUserTokens()).toBeGreaterThan(0);
  });

  it("leaves live tokens alone when pruning", async () => {
    const token = await service.issueUserToken(userId, reset());
    await service.pruneUserTokens();

    expect(await service.consumeUserToken(token, reset())).toBe(userId);
  });
});
