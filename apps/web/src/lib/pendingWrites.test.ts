import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discardWrite,
  flushAllWrites,
  flushWrite,
  pendingPaths,
  queueWrite,
  renameWrite,
  resetPendingWrites,
  setWriteEmitter,
} from "./pendingWrites.ts";

let written: [string, string][];

beforeEach(() => {
  vi.useFakeTimers();
  resetPendingWrites();
  written = [];
  setWriteEmitter((relPath, data) => written.push([relPath, data]));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("debounced writes", () => {
  it("sends nothing before the delay elapses", () => {
    queueWrite("a.ts", "one", 800);
    vi.advanceTimersByTime(799);

    expect(written).toEqual([]);
  });

  it("sends once the delay elapses", () => {
    queueWrite("a.ts", "one", 800);
    vi.advanceTimersByTime(800);

    expect(written).toEqual([["a.ts", "one"]]);
  });

  it("collapses repeated edits to one write of the latest text", () => {
    queueWrite("a.ts", "one", 800);
    vi.advanceTimersByTime(400);
    queueWrite("a.ts", "two", 800);
    vi.advanceTimersByTime(400);
    queueWrite("a.ts", "three", 800);
    vi.advanceTimersByTime(800);

    expect(written).toEqual([["a.ts", "three"]]);
  });

  it("does NOT let one file cancel another file's pending write", () => {
    // The bug this module exists to make impossible: a single shared timer
    // meant typing in b.ts discarded a.ts's unsaved edits entirely.
    queueWrite("a.ts", "edits to A", 800);
    vi.advanceTimersByTime(100);
    queueWrite("b.ts", "edits to B", 800);
    vi.advanceTimersByTime(800);

    expect(written).toContainEqual(["a.ts", "edits to A"]);
    expect(written).toContainEqual(["b.ts", "edits to B"]);
  });

  it("keeps many files in flight at once", () => {
    for (const name of ["a", "b", "c", "d"]) queueWrite(`${name}.ts`, name, 800);

    expect(pendingPaths()).toHaveLength(4);
    vi.advanceTimersByTime(800);
    expect(written).toHaveLength(4);
  });
});

describe("flushing", () => {
  it("sends one path immediately and clears its timer", () => {
    queueWrite("a.ts", "one", 800);
    flushWrite("a.ts");

    expect(written).toEqual([["a.ts", "one"]]);

    // The timer must not fire a second write afterwards.
    vi.advanceTimersByTime(800);
    expect(written).toHaveLength(1);
  });

  it("is a no-op for a path with nothing queued", () => {
    flushWrite("nothing.ts");
    expect(written).toEqual([]);
  });

  it("sends every pending write", () => {
    queueWrite("a.ts", "A", 800);
    queueWrite("b.ts", "B", 800);
    flushAllWrites();

    expect(written).toHaveLength(2);
    expect(pendingPaths()).toEqual([]);
  });

  it("leaves nothing behind after flushing all", () => {
    queueWrite("a.ts", "A", 800);
    flushAllWrites();
    vi.advanceTimersByTime(5000);

    expect(written).toHaveLength(1);
  });
});

describe("discarding", () => {
  it("drops a write without sending it", () => {
    // A deleted file must not be written back, which would recreate it.
    queueWrite("gone.ts", "contents", 800);
    discardWrite("gone.ts");
    vi.advanceTimersByTime(800);

    expect(written).toEqual([]);
    expect(pendingPaths()).toEqual([]);
  });

  it("leaves other paths alone", () => {
    queueWrite("gone.ts", "x", 800);
    queueWrite("kept.ts", "y", 800);
    discardWrite("gone.ts");
    vi.advanceTimersByTime(800);

    expect(written).toEqual([["kept.ts", "y"]]);
  });
});

describe("without an emitter", () => {
  it("drops a queued write rather than throwing", () => {
    setWriteEmitter(null);
    queueWrite("a.ts", "one", 800);

    expect(() => vi.advanceTimersByTime(800)).not.toThrow();
    expect(pendingPaths()).toEqual([]);
  });
});

describe("a file that is renamed mid-write", () => {
  it("sends the queued text under the new name", () => {
    queueWrite("old.ts", "typed", 800);
    renameWrite("old.ts", "new.ts");
    vi.advanceTimersByTime(800);

    // Under the old name this recreates the file the rename just moved; and
    // dropping it instead would lose whatever was typed last.
    expect(written).toEqual([["new.ts", "typed"]]);
  });

  it("leaves the old name with nothing queued", () => {
    queueWrite("old.ts", "typed", 800);
    renameWrite("old.ts", "new.ts");

    expect(pendingPaths()).toEqual(["new.ts"]);
  });

  it("does nothing for a file that had no write queued", () => {
    queueWrite("other.ts", "kept", 800);
    renameWrite("old.ts", "new.ts");
    vi.advanceTimersByTime(800);

    expect(written).toEqual([["other.ts", "kept"]]);
  });

  it("does not disturb another file's pending write", () => {
    queueWrite("old.ts", "moved", 800);
    queueWrite("other.ts", "stays", 800);
    renameWrite("old.ts", "new.ts");
    vi.advanceTimersByTime(800);

    expect(written.sort()).toEqual([["new.ts", "moved"], ["other.ts", "stays"]]);
  });
});
