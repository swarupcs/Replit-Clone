import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  userPersonalization: { findUnique: vi.fn(), upsert: vi.fn() },
  project: { findUnique: vi.fn() },
}));
vi.mock("../lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  accountSshKeys,
  getAccountSshKeys,
  setAccountSshKeys,
} from "./accountSshKeyService.js";

const USER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function key(seed = 4, comment = "me@laptop") {
  const type = Buffer.from("ssh-ed25519", "ascii");
  const blob = Buffer.concat([prefix(type), prefix(Buffer.alloc(32, seed))]).toString(
    "base64",
  );
  return `ssh-ed25519 ${blob} ${comment}`;
}
function prefix(value: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.userPersonalization.findUnique.mockResolvedValue(null);
  prismaMock.project.findUnique.mockResolvedValue({ ownerId: USER });
});

describe("an account's keys", () => {
  it("is empty for an account that has never added one", () => {
    return expect(getAccountSshKeys(USER)).resolves.toEqual([]);
  });

  it("stores the line and reads it back parsed", async () => {
    await setAccountSshKeys(USER, [key()]);

    const call = prismaMock.userPersonalization.upsert.mock.calls[0]?.[0] as {
      update: { sshKeys: string[] };
    };
    expect(call.update.sshKeys).toEqual([key()]);
  });

  it("stores a public key in the clear", async () => {
    // A public key is public. Sealing it would imply a confidentiality it does
    // not have, and "who can log into this box" is a question an operator is
    // entitled to answer by reading the database.
    await setAccountSshKeys(USER, [key()]);
    const call = prismaMock.userPersonalization.upsert.mock.calls[0]?.[0] as {
      create: { sshKeys: string[] };
    };
    expect(call.create.sshKeys[0]).toContain("ssh-ed25519 ");
  });

  it("replaces the whole set rather than merging", async () => {
    prismaMock.userPersonalization.findUnique.mockResolvedValue({
      sshKeys: [key(1)],
    });

    await setAccountSshKeys(USER, [key(2)]);

    // Removing a key that should no longer open your workspaces is the
    // operation somebody most needs to be certain of.
    const call = prismaMock.userPersonalization.upsert.mock.calls[0]?.[0] as {
      update: { sshKeys: string[] };
    };
    expect(call.update.sshKeys).toEqual([key(2)]);
  });

  it("writes nothing when one line of the paste is bad", async () => {
    await expect(setAccountSshKeys(USER, [key(), "nonsense"])).rejects.toThrow();
    expect(prismaMock.userPersonalization.upsert).not.toHaveBeenCalled();
  });

  it("refuses a list that is not a list", async () => {
    await expect(setAccountSshKeys(USER, "ssh-ed25519 AAAA")).rejects.toThrow(
      /list of public keys/,
    );
  });

  it("refuses more keys than one person has machines", async () => {
    const many = Array.from({ length: 11 }, (_, index) => key(index + 1));
    await expect(setAccountSshKeys(USER, many)).rejects.toThrow(/At most/);
  });

  it("re-parses on the way out, so a tightened rule takes effect", async () => {
    prismaMock.userPersonalization.findUnique.mockResolvedValue({
      sshKeys: [key(), "ssh-dss AAAA"],
    });

    // A row written under looser rules should stop being served, not keep
    // working because it is already in the database. This one throws inside
    // and degrades to empty rather than serving the half it likes -- said out
    // loud because it is a choice.
    await expect(getAccountSshKeys(USER)).resolves.toEqual([]);
  });

  it("survives a column holding something that is not a list", async () => {
    prismaMock.userPersonalization.findUnique.mockResolvedValue({ sshKeys: {} });
    await expect(getAccountSshKeys(USER)).resolves.toEqual([]);
  });
});

describe("which keys a container accepts", () => {
  it("takes the owner's", async () => {
    prismaMock.userPersonalization.findUnique.mockResolvedValue({
      sshKeys: [key()],
    });

    await expect(accountSshKeys(PROJECT)).resolves.toHaveLength(1);
    expect(prismaMock.userPersonalization.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER } }),
    );
  });

  it("is empty for a project that does not exist", async () => {
    prismaMock.project.findUnique.mockResolvedValue(null);
    await expect(accountSshKeys(PROJECT)).resolves.toEqual([]);
  });

  it("does not fail a container start because the lookup did", async () => {
    prismaMock.project.findUnique.mockRejectedValue(new Error("database is down"));

    // An editor you can attach is an addition to a workspace, not a
    // precondition for one.
    await expect(accountSshKeys(PROJECT)).resolves.toEqual([]);
  });
});
