import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const prismaMock = vi.hoisted(() => ({
  apiKey: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
}));

vi.mock("../lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
}));

import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  verifyApiKey,
} from "./apiKeyService.js";

const USER = "11111111-1111-4111-8111-111111111111";

function row(over: Record<string, unknown> = {}) {
  return {
    id: "key-1",
    userId: USER,
    label: "CI",
    prefix: "rc_abcdef012345",
    tokenHash: "unset",
    scopes: ["projects:read"],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date("2026-08-30T09:00:00.000Z"),
    user: { email: "someone@example.com" },
    ...over,
  };
}

beforeEach(() => {
  prismaMock.apiKey.findMany.mockReset().mockResolvedValue([]);
  prismaMock.apiKey.findUnique.mockReset().mockResolvedValue(null);
  prismaMock.apiKey.create.mockReset().mockImplementation(({ data }) =>
    Promise.resolve({ ...row(), ...data, createdAt: new Date() }),
  );
  prismaMock.apiKey.update.mockReset().mockResolvedValue(row());
  prismaMock.apiKey.updateMany.mockReset().mockResolvedValue({ count: 1 });
  prismaMock.apiKey.count.mockReset().mockResolvedValue(0);
});

describe("minting a key", () => {
  it("returns the secret once, and stores only its hash", async () => {
    const created = await createApiKey({
      userId: USER,
      label: "CI",
      scopes: ["deploy"],
    });

    expect(created.secret).toMatch(/^rc_[0-9a-f]{12}_/);

    const stored = prismaMock.apiKey.create.mock.calls[0]?.[0] as {
      data: { tokenHash: string; prefix: string };
    };
    // The secret itself appears nowhere in what is written.
    expect(stored.data.tokenHash).not.toContain(created.secret);
    expect(stored.data.tokenHash).toBe(
      createHash("sha256").update(created.secret).digest("hex"),
    );
    // The prefix is the public half, and it is IN the secret — which is what
    // lets a key be named in a list without the row holding anything usable.
    expect(created.secret.startsWith(stored.data.prefix)).toBe(true);
  });

  it("does not hand out the same secret twice", async () => {
    const first = await createApiKey({ userId: USER, label: "a", scopes: ["deploy"] });
    const second = await createApiKey({ userId: USER, label: "b", scopes: ["deploy"] });

    expect(first.secret).not.toBe(second.secret);
    expect(first.key.prefix).not.toBe(second.key.prefix);
  });

  /** A key that can do nothing is not a safer key, it is a confusing one: it
   *  fails on first use with a message about permissions rather than one about
   *  how it was made. */
  it("refuses a key with no scopes and one with no name", async () => {
    await expect(
      createApiKey({ userId: USER, label: "CI", scopes: [] }),
    ).rejects.toMatchObject({ code: "NO_SCOPES" });

    await expect(
      createApiKey({ userId: USER, label: "   ", scopes: ["deploy"] }),
    ).rejects.toMatchObject({ code: "BAD_LABEL" });
  });

  /** An account with forty keys has lost track of them, which is the state
   *  this feature exists to keep people out of. */
  it("refuses past the cap, counting only live ones", async () => {
    prismaMock.apiKey.count.mockResolvedValue(10);

    await expect(
      createApiKey({ userId: USER, label: "CI", scopes: ["deploy"] }),
    ).rejects.toMatchObject({ code: "KEY_LIMIT" });

    expect(prismaMock.apiKey.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER, revokedAt: null } }),
    );
  });
});

describe("presenting a key", () => {
  /** The whole point: the row holds a hash, so verification has to be able to
   *  work from the presented string alone. */
  it("is accepted when it matches, and says who it is", async () => {
    const created = await createApiKey({
      userId: USER,
      label: "CI",
      scopes: ["deploy", "projects:read"],
    });

    prismaMock.apiKey.findUnique.mockResolvedValue(
      row({
        prefix: created.key.prefix,
        tokenHash: createHash("sha256").update(created.secret).digest("hex"),
        scopes: ["deploy", "projects:read"],
      }),
    );

    const verified = await verifyApiKey(created.secret);

    expect(verified.userId).toBe(USER);
    expect(verified.email).toBe("someone@example.com");
    expect(verified.scopes).toEqual(["deploy", "projects:read"]);
  });

  /** Every refusal says the same thing. Distinguishing "no such key" from
   *  "revoked" from "expired" tells somebody holding a stolen string which of
   *  those it is, and tells the rightful owner nothing their own list does not
   *  already say. */
  it("is refused identically whatever is wrong with it", async () => {
    const secret = "rc_abcdef012345_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const good = createHash("sha256").update(secret).digest("hex");

    const cases = [
      null,
      row({ tokenHash: "some-other-hash" }),
      row({ tokenHash: good, revokedAt: new Date("2026-08-30T00:00:00.000Z") }),
      row({ tokenHash: good, expiresAt: new Date("2026-08-30T00:00:00.000Z") }),
    ];

    for (const found of cases) {
      prismaMock.apiKey.findUnique.mockResolvedValue(found);
      await expect(verifyApiKey(secret)).rejects.toMatchObject({
        statusCode: 401,
        code: "BAD_API_KEY",
      });
    }
  });

  it("is refused when it is not even shaped like one", async () => {
    for (const bad of ["", "nonsense", "Bearer x", "xx_yy_zz", "rc_only"]) {
      await expect(verifyApiKey(bad)).rejects.toMatchObject({
        code: "BAD_API_KEY",
      });
    }
    // Nothing malformed should have reached the database at all.
    expect(prismaMock.apiKey.findUnique).not.toHaveBeenCalled();
  });

  /** A key that expires in future is fine — only a past one is not. */
  it("is accepted while its expiry is still ahead", async () => {
    const secret = "rc_abcdef012345_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    prismaMock.apiKey.findUnique.mockResolvedValue(
      row({
        tokenHash: createHash("sha256").update(secret).digest("hex"),
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    );

    await expect(verifyApiKey(secret)).resolves.toMatchObject({ userId: USER });
  });

  /** The question `lastUsedAt` answers is "is anything still using this",
   *  which is what makes revoking an unfamiliar key safe rather than a gamble.
   *  It does not need a database write per request to answer it. */
  it("records that it was used, but not on every call", async () => {
    const secret = "rc_abcdef012345_cccccccccccccccccccccccccccccccc";
    const hash = createHash("sha256").update(secret).digest("hex");

    prismaMock.apiKey.findUnique.mockResolvedValue(row({ tokenHash: hash }));
    await verifyApiKey(secret);
    expect(prismaMock.apiKey.update).toHaveBeenCalledTimes(1);

    prismaMock.apiKey.findUnique.mockResolvedValue(
      row({ tokenHash: hash, lastUsedAt: new Date() }),
    );
    await verifyApiKey(secret);
    expect(prismaMock.apiKey.update).toHaveBeenCalledTimes(1);
  });
});

describe("revoking a key", () => {
  /** Scoped in the WHERE clause rather than checked first: a filter that
   *  cannot match another person's row is stronger than a check somebody has
   *  to remember to run. */
  it("cannot reach somebody else's", async () => {
    await revokeApiKey(USER, "key-1");

    expect(prismaMock.apiKey.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "key-1", userId: USER, revokedAt: null },
      }),
    );
  });

  it("says so when there was nothing to revoke", async () => {
    prismaMock.apiKey.updateMany.mockResolvedValue({ count: 0 });

    await expect(revokeApiKey(USER, "key-1")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  /** A timestamp, not a delete: "that key was revoked on Tuesday" is the
   *  sentence somebody needs after an incident. */
  it("leaves the key in the list, marked", async () => {
    prismaMock.apiKey.findMany.mockResolvedValue([
      row({ revokedAt: new Date("2026-08-31T09:00:00.000Z") }),
    ]);

    const keys = await listApiKeys(USER);

    expect(keys).toHaveLength(1);
    expect(keys[0]?.revokedAt).toBe("2026-08-31T09:00:00.000Z");
  });
});

/** A scope that is not one of the three cannot be granted by anything that
 *  wrote directly to the column. */
describe("the scopes on a row", () => {
  it("are filtered to the ones this product defines", async () => {
    prismaMock.apiKey.findMany.mockResolvedValue([
      row({ scopes: ["projects:read", "admin", "*"] }),
    ]);

    const keys = await listApiKeys(USER);

    expect(keys[0]?.scopes).toEqual(["projects:read"]);
  });
});
