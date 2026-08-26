import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbScope } from "../test/dbScope.js";

/** The connection is the one place a credential is written down, so it is
 *  exercised against real rows rather than a mocked Prisma. What the column
 *  actually holds, and whether the constraints behave, are not things a stub
 *  can answer. Set TEST_DATABASE_URL to a throwaway Postgres with the
 *  migrations applied; CI always does. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

const TOKEN = "gho_a-real-looking-token";

describe.skipIf(!TEST_DATABASE_URL)("the stored GitHub connection", () => {
  const scope = dbScope("github-connection");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let service: typeof import("./githubService.js");
  let secretBox: typeof import("../lib/secretBox.js");

  let userId: string;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ prisma } = await import("../lib/prisma.js"));
    service = await import("./githubService.js");
    secretBox = await import("../lib/secretBox.js");
  });

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: { email: scope.email("owner"), passwordHash: "x" },
    });
    userId = user.id;
  });

  afterEach(async () => {
    await scope.cleanup(prisma);
  });

  /** Writes a connection the way `connectGithub` does, without the round trip
   *  through GitHub — the exchange is covered by the unit tests; what is under
   *  test here is the row. */
  async function store(token = TOKEN, scopes = "repo,read:user") {
    return prisma.githubConnection.create({
      data: {
        userId,
        tokenCipher: secretBox.seal(token),
        scopes,
        login: "octocat",
      },
    });
  }

  it("puts ciphertext in the column, not the token", async () => {
    await store();

    // Read back through Prisma rather than through the service, so this is
    // what a database dump would contain.
    const row = await prisma.githubConnection.findUnique({ where: { userId } });

    expect(row?.tokenCipher).toBeTruthy();
    expect(row?.tokenCipher).not.toContain(TOKEN);
    expect(row?.tokenCipher).not.toContain("gho_");
  });

  it("round-trips the token back out again", async () => {
    await store();
    expect(await service.githubToken(userId)).toBe(TOKEN);
  });

  it("describes the connection without the credential", async () => {
    await store();

    const info = await service.githubConnection(userId);

    expect(info).toMatchObject({ login: "octocat", canUseRepos: true });
    expect(JSON.stringify(info)).not.toContain(TOKEN);
  });

  it("holds one connection per user", async () => {
    await store();

    // A second would be ambiguous about which token to spend, so the database
    // refuses it rather than leaving the choice to whichever query ran first.
    await expect(store("another-token")).rejects.toThrow();
  });

  it("replaces the token when reconnecting", async () => {
    await store();

    await prisma.githubConnection.update({
      where: { userId },
      data: { tokenCipher: secretBox.seal("gho_the-new-one") },
    });

    // Superseded, not accumulated: keeping the old one would only be another
    // thing to leak.
    expect(await service.githubToken(userId)).toBe("gho_the-new-one");
  });

  it("goes away with the account", async () => {
    await store();
    await prisma.user.delete({ where: { id: userId } });

    expect(
      await prisma.githubConnection.findUnique({ where: { userId } }),
    ).toBeNull();
  });

  it("is deleted, not flagged, on disconnect", async () => {
    await store();
    await service.disconnectGithub(userId);

    expect(
      await prisma.githubConnection.findUnique({ where: { userId } }),
    ).toBeNull();
  });

  it("drops a row it can no longer decrypt", async () => {
    // What a key rotation leaves behind. Left in place it fails on every
    // future call with nothing the user can do about it.
    await prisma.githubConnection.create({
      data: {
        userId,
        tokenCipher: "v1.not.a.value",
        scopes: "repo",
        login: "octocat",
      },
    });

    await expect(service.githubToken(userId)).rejects.toThrow(/Connect again/);
    expect(
      await prisma.githubConnection.findUnique({ where: { userId } }),
    ).toBeNull();
  });
});
