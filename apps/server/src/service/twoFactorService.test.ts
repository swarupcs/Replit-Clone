import { beforeEach, describe, expect, it, vi } from "vitest";

/** A second factor, and the four ways one is usually got wrong.
 *
 *  Confirmation, because a factor enabled without proving the app holds the
 *  secret locks the account on the next sign-in. Replay, because a TOTP code
 *  is valid for a whole window and one seen over a shoulder otherwise works
 *  again. Recovery codes, because a lost phone must not be a lost account on a
 *  deployment with no support desk. And the unconfirmed row, which must never
 *  be treated as protection.
 */

const findUnique = vi.hoisted(() => vi.fn());
const upsert = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const deleteMany = vi.hoisted(() => vi.fn());
vi.mock("../lib/prisma.js", () => ({
  prisma: { userTwoFactor: { findUnique, upsert, update, deleteMany } },
}));

/** The box is stubbed; the TOTP maths is NOT. Encryption has its own tests,
 *  and a stubbed verifier would leave these testing nothing but bookkeeping. */
vi.mock("../lib/secretBox.js", () => ({
  isSecretBoxConfigured: () => configured,
  seal: (value: string) => `sealed(${value})`,
  open: (value: string) => {
    const match = /^sealed\((.*)\)$/.exec(value);
    if (!match) throw new Error("sealed under a different key");
    return match[1] ?? "";
  },
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/metrics.js", () => ({ increment: vi.fn() }));

let configured = true;

const {
  beginEnrolment,
  confirmEnrolment,
  consumeSecondFactor,
  disableTwoFactor,
  getTwoFactorStatus,
  regenerateRecoveryCodes,
  requiresSecondFactor,
} = await import("./twoFactorService.js");

const { currentCode, generateSecret, stepFor } = await import("../lib/totp.js");

const SECRET = generateSecret();
const USER = "u1";

/** A confirmed row, as the database would hand it back. */
function enrolled(over: Record<string, unknown> = {}) {
  return {
    userId: USER,
    secret: `sealed(${SECRET})`,
    confirmedAt: new Date("2026-09-01"),
    recoveryCodeHashes: [],
    lastUsedStep: null,
    ...over,
  };
}

function written(): Record<string, unknown> {
  return (update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  configured = true;
  findUnique.mockResolvedValue(null);
  upsert.mockResolvedValue(undefined);
  update.mockResolvedValue(undefined);
  deleteMany.mockResolvedValue({ count: 1 });
});

describe("what counts as protected", () => {
  it("is off for an account with no row", async () => {
    expect(await requiresSecondFactor(USER)).toBe(false);
    expect(await getTwoFactorStatus(USER)).toEqual({
      enabled: false,
      pending: false,
      recoveryCodesLeft: 0,
    });
  });

  /** The one that would lock somebody out. An abandoned setup screen must not
   *  become a gate in front of a secret nobody wrote down. */
  it("does not treat an unconfirmed enrolment as protection", async () => {
    findUnique.mockResolvedValue({ confirmedAt: null, recoveryCodeHashes: [] });

    expect(await requiresSecondFactor(USER)).toBe(false);
    expect(await getTwoFactorStatus(USER)).toEqual({
      enabled: false,
      pending: true,
      recoveryCodesLeft: 0,
    });
  });

  it("reports how many recovery codes are left", async () => {
    findUnique.mockResolvedValue({
      confirmedAt: new Date(),
      recoveryCodeHashes: ["a", "b", "c"],
    });

    expect(await getTwoFactorStatus(USER)).toEqual({
      enabled: true,
      pending: false,
      recoveryCodesLeft: 3,
    });
  });
});

describe("enrolling", () => {
  it("offers a secret and a URL an app can scan", async () => {
    const offer = await beginEnrolment(USER, "someone@example.com");

    expect(offer.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(offer.otpauthUrl).toContain("otpauth://totp/");
    expect(offer.otpauthUrl).toContain(`secret=${offer.secret}`);
  });

  it("seals the secret rather than storing it", async () => {
    const offer = await beginEnrolment(USER, "someone@example.com");

    const call = upsert.mock.calls[0]?.[0] as {
      create: { secret: string };
      update: { secret: string };
    };
    expect(call.create.secret).toBe(`sealed(${offer.secret})`);
    expect(call.create.secret).not.toBe(offer.secret);
  });

  /** Starting over has to be possible -- the only way to arrive here twice is
   *  to have lost the first secret -- but an abandoned attempt must leave
   *  nothing of itself behind, particularly not a step counter belonging to a
   *  different secret. */
  it("resets an unfinished enrolment completely", async () => {
    await beginEnrolment(USER, "someone@example.com");

    const call = upsert.mock.calls[0]?.[0] as {
      update: Record<string, unknown>;
    };
    expect(call.update.confirmedAt).toBeNull();
    expect(call.update.lastUsedStep).toBeNull();
    expect(call.update.recoveryCodeHashes).toEqual([]);
  });

  /** Overwriting a WORKING second factor with an unconfirmed one would turn a
   *  misclick into being locked out. */
  it("refuses to restart over a factor that is already on", async () => {
    findUnique.mockResolvedValue({ confirmedAt: new Date() });

    await expect(beginEnrolment(USER, "a@b.test")).rejects.toThrow(
      /already on/,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses when the server cannot keep a secret at all", async () => {
    configured = false;

    await expect(beginEnrolment(USER, "a@b.test")).rejects.toThrow(
      /SECRET_ENCRYPTION_KEY/,
    );
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("confirming", () => {
  /** The whole reason this step exists: it proves the app really has the
   *  secret, before anything starts depending on that. */
  it("refuses a wrong code and turns nothing on", async () => {
    findUnique.mockResolvedValue(enrolled({ confirmedAt: null }));

    await expect(confirmEnrolment(USER, "000000")).rejects.toThrow(
      /did not match/,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("turns it on and issues ten recovery codes", async () => {
    findUnique.mockResolvedValue(enrolled({ confirmedAt: null }));

    const codes = await confirmEnrolment(USER, currentCode(SECRET));

    expect(codes).toHaveLength(10);
    // Readable here, and hashes in the database.
    expect(codes[0]).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}$/);
    const stored = written().recoveryCodeHashes as string[];
    expect(stored).toHaveLength(10);
    for (const hash of stored) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(codes[0]);
  });

  /** The code that enabled it is spent, or it would still work for the rest of
   *  its window at the first sign-in. */
  it("records the step the confirming code used", async () => {
    findUnique.mockResolvedValue(enrolled({ confirmedAt: null }));

    await confirmEnrolment(USER, currentCode(SECRET));

    expect(written().lastUsedStep).toBe(BigInt(stepFor(Date.now())));
  });

  it("refuses when nothing was started", async () => {
    await expect(confirmEnrolment(USER, "123456")).rejects.toThrow(
      /Start setting up/,
    );
  });
});

describe("signing in with it", () => {
  it("accepts the current code", async () => {
    findUnique.mockResolvedValue(enrolled());

    expect(await consumeSecondFactor(USER, currentCode(SECRET))).toBe("totp");
    expect(written().lastUsedStep).toBe(BigInt(stepFor(Date.now())));
  });

  /** The replay guard. A code is valid for a whole window, so without this one
   *  read over a shoulder -- or captured in front of a phishing page -- works
   *  again for the next thirty seconds. */
  it("refuses a code that has already been used", async () => {
    findUnique.mockResolvedValue(
      enrolled({ lastUsedStep: BigInt(stepFor(Date.now())) }),
    );

    await expect(
      consumeSecondFactor(USER, currentCode(SECRET)),
    ).rejects.toThrow(/already been used/);
    expect(update).not.toHaveBeenCalled();
  });

  /** A code from the window BEFORE the last one used is also a replay, and the
   *  comparison has to be `<=` rather than `===` to catch it. */
  it("refuses an older code as well", async () => {
    const now = Date.now();
    findUnique.mockResolvedValue(
      enrolled({ lastUsedStep: BigInt(stepFor(now)) }),
    );

    await expect(
      consumeSecondFactor(USER, currentCode(SECRET, now - 30_000)),
    ).rejects.toThrow(/already been used/);
  });

  it("refuses a wrong code", async () => {
    findUnique.mockResolvedValue(enrolled());

    await expect(consumeSecondFactor(USER, "000000")).rejects.toThrow(
      /not right/,
    );
  });

  /** Reachable if the factor is turned off between the password step and this
   *  one. A session must not be issued from a challenge nothing verified. */
  it("refuses when the factor is not on", async () => {
    findUnique.mockResolvedValue(null);

    await expect(consumeSecondFactor(USER, "123456")).rejects.toThrow(
      /not enabled/,
    );
  });

  /** Fails CLOSED, unlike the signing key. Falling back to "no second factor"
   *  when the box will not open would be a downgrade attack in one environment
   *  variable. */
  it("refuses rather than waving through a secret it cannot read", async () => {
    findUnique.mockResolvedValue(enrolled({ secret: "not-openable" }));

    await expect(consumeSecondFactor(USER, "123456")).rejects.toThrow(
      /cannot be read/,
    );
  });
});

describe("recovery codes", () => {
  /** The same box as a TOTP code, because somebody who has lost their phone
   *  should not have to find the right tab first. */
  it("accepts one in place of a code from the app", async () => {
    findUnique.mockResolvedValue(enrolled({ confirmedAt: null }));
    const codes = await confirmEnrolment(USER, currentCode(SECRET));
    const hashes = written().recoveryCodeHashes as string[];

    vi.clearAllMocks();
    findUnique.mockResolvedValue(enrolled({ recoveryCodeHashes: hashes }));

    expect(await consumeSecondFactor(USER, codes[3]!)).toBe("recovery");
  });

  /** Once each. A code that kept working would be a permanent password with
   *  none of the protections one has. */
  it("spends the code it accepted", async () => {
    findUnique.mockResolvedValue(enrolled({ confirmedAt: null }));
    const codes = await confirmEnrolment(USER, currentCode(SECRET));
    const hashes = written().recoveryCodeHashes as string[];

    vi.clearAllMocks();
    findUnique.mockResolvedValue(enrolled({ recoveryCodeHashes: hashes }));
    await consumeSecondFactor(USER, codes[0]!);

    const remaining = written().recoveryCodeHashes as string[];
    expect(remaining).toHaveLength(9);
    expect(remaining).not.toContain(hashes[0]);
  });

  /** People type these off paper. Case, hyphen and a stray space are all the
   *  same code. */
  it("takes a code however it was transcribed", async () => {
    findUnique.mockResolvedValue(enrolled({ confirmedAt: null }));
    const codes = await confirmEnrolment(USER, currentCode(SECRET));
    const hashes = written().recoveryCodeHashes as string[];

    vi.clearAllMocks();
    findUnique.mockResolvedValue(enrolled({ recoveryCodeHashes: hashes }));

    const messy = ` ${codes[1]!.replace("-", "").toUpperCase()} `;
    expect(await consumeSecondFactor(USER, messy)).toBe("recovery");
  });

  it("refuses one that was never issued", async () => {
    findUnique.mockResolvedValue(
      enrolled({ recoveryCodeHashes: ["a".repeat(64)] }),
    );

    await expect(consumeSecondFactor(USER, "abcd-efgh")).rejects.toThrow(
      /not right/,
    );
  });

  it("issues a new set, invalidating the old", async () => {
    findUnique.mockResolvedValue({ confirmedAt: new Date() });

    const codes = await regenerateRecoveryCodes(USER);

    expect(codes).toHaveLength(10);
    expect(written().recoveryCodeHashes).toHaveLength(10);
  });

  it("will not issue codes for an account with no second factor", async () => {
    findUnique.mockResolvedValue(null);

    await expect(regenerateRecoveryCodes(USER)).rejects.toThrow(/not on/);
  });
});

describe("turning it off", () => {
  it("removes the row entirely", async () => {
    await disableTwoFactor(USER);

    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
  });
});
