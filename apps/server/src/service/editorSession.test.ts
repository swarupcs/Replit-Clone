import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  userEditorState: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
}));
vi.mock("../lib/prisma.js", () => ({ prisma: prismaMock }));

import {
  getEditorSession,
  parseSessionUpdate,
  setEditorSession,
} from "./editorSessionService.js";
import { MAX_SESSION_VALUE_BYTES } from "@replit-clone/shared";

const USER = "11111111-1111-4111-8111-111111111111";
const AT = new Date("2026-09-09T10:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.userEditorState.findMany.mockResolvedValue([]);
  prismaMock.userEditorState.upsert.mockResolvedValue({});
  prismaMock.userEditorState.deleteMany.mockResolvedValue({ count: 0 });
});

describe("reading an account's editor session", () => {
  it("is empty for somebody who has only ever used one browser", async () => {
    // Which is every account that existed before this table did.
    await expect(getEditorSession(USER)).resolves.toEqual({ entries: {} });
  });

  it("returns the value, its revision and when it changed", async () => {
    prismaMock.userEditorState.findMany.mockResolvedValue([
      { key: "rc-theme", value: { choice: "dark" }, rev: 4, updatedAt: AT },
    ]);

    await expect(getEditorSession(USER)).resolves.toEqual({
      entries: {
        "rc-theme": {
          value: { choice: "dark" },
          rev: 4,
          updatedAt: "2026-09-09T10:00:00.000Z",
        },
      },
    });
  });

  it("drops a key that is no longer syncable", async () => {
    prismaMock.userEditorState.findMany.mockResolvedValue([
      { key: "rc-theme", value: {}, rev: 1, updatedAt: AT },
      { key: "rc-retired", value: {}, rev: 1, updatedAt: AT },
    ]);

    // A row written by an older build whose key has since left the allowlist
    // must stop being served, or the allowlist only governs writes.
    const state = await getEditorSession(USER);
    expect(Object.keys(state.entries)).toEqual(["rc-theme"]);
  });

  it("asks only for the keys it is willing to return", async () => {
    await getEditorSession(USER);

    const where = prismaMock.userEditorState.findMany.mock.calls[0]?.[0] as {
      where: { userId: string; key: { in: string[] } };
    };
    expect(where.where.userId).toBe(USER);
    expect(where.where.key.in).toContain("rc-workspace");
  });
});

describe("what a client is allowed to store", () => {
  it("refuses a key that is not one of the stores", () => {
    // Otherwise this is a key/value store any browser can write anything into.
    expect(() => parseSessionUpdate({ entries: { "rc-anything": {} } })).toThrow(
      /not a syncable setting/,
    );
  });

  it("refuses a value too large to be a layout", () => {
    const huge = { pad: "x".repeat(MAX_SESSION_VALUE_BYTES + 1) };
    expect(() => parseSessionUpdate({ entries: { "rc-workspace": huge } })).toThrow(
      /too large/,
    );
  });

  it("refuses a body that is not an object of entries", () => {
    expect(() => parseSessionUpdate({ entries: [1, 2] })).toThrow(/object of entries/);
    expect(() => parseSessionUpdate({})).toThrow(/object of entries/);
  });

  it("accepts a patch naming one store", () => {
    const patch = parseSessionUpdate({ entries: { "rc-theme": { choice: "light" } } });
    expect([...patch.keys()]).toEqual(["rc-theme"]);
  });

  it("writes nothing when any key in the patch is rejected", async () => {
    await expect(
      setEditorSession(USER, {
        entries: { "rc-theme": { choice: "dark" }, "rc-bogus": {} },
      }),
    ).rejects.toThrow();

    // A half-applied save is the state nobody can reason about afterwards, so
    // the whole patch is validated before the first write.
    expect(prismaMock.userEditorState.upsert).not.toHaveBeenCalled();
  });
});

describe("writing it", () => {
  it("creates the row on a first save and bumps it after that", async () => {
    await setEditorSession(USER, { entries: { "rc-theme": { choice: "dark" } } });

    const call = prismaMock.userEditorState.upsert.mock.calls[0]?.[0] as {
      where: { userId_key: { userId: string; key: string } };
      create: { value: unknown };
      update: { rev: { increment: number } };
    };
    expect(call.where.userId_key).toEqual({ userId: USER, key: "rc-theme" });
    expect(call.create.value).toEqual({ choice: "dark" });

    // `increment`, not a read-then-write: two tabs saving at the same instant
    // would otherwise compute the same next revision, and a revision that
    // repeats is one a client cannot use to tell writes apart.
    expect(call.update.rev).toEqual({ increment: 1 });
  });

  it("touches only the keys it was sent", async () => {
    await setEditorSession(USER, { entries: { "rc-keybindings": { overrides: {} } } });

    expect(prismaMock.userEditorState.upsert).toHaveBeenCalledTimes(1);
    // The whole point of a row per key: two machines changing different things
    // are not writing the same row, so neither overwrites the other.
    const call = prismaMock.userEditorState.upsert.mock.calls[0]?.[0] as {
      where: { userId_key: { key: string } };
    };
    expect(call.where.userId_key.key).toBe("rc-keybindings");
  });

  it("treats an explicit null as a removal", async () => {
    await setEditorSession(USER, { entries: { "rc-workspace": null } });

    expect(prismaMock.userEditorState.upsert).not.toHaveBeenCalled();
    expect(prismaMock.userEditorState.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER, key: "rc-workspace" },
    });
  });

  it("does not fail when removing a key that was never stored", async () => {
    // Which is exactly what a client sends after somebody resets a store.
    await expect(
      setEditorSession(USER, { entries: { "rc-theme": null } }),
    ).resolves.toEqual({ entries: {} });
  });

  it("returns what is stored rather than echoing what was sent", async () => {
    prismaMock.userEditorState.findMany.mockResolvedValue([
      { key: "rc-theme", value: { choice: "dark" }, rev: 7, updatedAt: AT },
    ]);

    // The revision is the caller's whole reason for reading the response, and
    // it is the one field the caller cannot compute.
    const state = await setEditorSession(USER, {
      entries: { "rc-theme": { choice: "dark" } },
    });
    expect(state.entries["rc-theme"]?.rev).toBe(7);
  });
});
