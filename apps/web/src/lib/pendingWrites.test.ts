import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmWrite,
  discardWrite,
  flushAllWrites,
  flushWrite,
  pendingPaths,
  queueWrite,
  renameWrite,
  resetPendingWrites,
  setWriteEmitter,
  setWriteScope,
  unsentPaths,
} from "./pendingWrites.ts";
import { recoveredBuffers } from "./recoveredWork.ts";

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
  /** This test used to assert the opposite — that the write was DROPPED — and
   *  that was the contract until §11.7. It was written to pin "does not
   *  throw", and the dropping came along with it unexamined: a flush with no
   *  emitter ended at `emit?.(...)`, where the optional call was quietly doing
   *  the work of an error handler. The editor uninstalls the emitter on
   *  unmount, so this was reachable by closing a tab with a keystroke still on
   *  the clock. */
  it("keeps a queued write instead of dropping it", () => {
    setWriteEmitter(null);
    queueWrite("a.ts", "one", 800);

    expect(() => vi.advanceTimersByTime(800)).not.toThrow();
    expect(unsentPaths()).toEqual(["a.ts"]);
  });

  it("sends what it kept as soon as there is somewhere to send it", () => {
    setWriteEmitter(null);
    queueWrite("a.ts", "one", 800);
    vi.advanceTimersByTime(800);
    expect(written).toEqual([]);

    setWriteEmitter((relPath, data) => written.push([relPath, data]));

    expect(written).toEqual([["a.ts", "one"]]);
    expect(unsentPaths()).toEqual([]);
  });

  /** A file edited repeatedly while offline sends its latest state once, not
   *  its history in order. Replaying the history would be slower and would end
   *  in the same place, and the intermediate states are not anything anybody
   *  asked to save. */
  it("keeps only the latest text per file", () => {
    setWriteEmitter(null);
    queueWrite("a.ts", "one", 0);
    vi.advanceTimersByTime(0);
    queueWrite("a.ts", "two", 0);
    vi.advanceTimersByTime(0);

    setWriteEmitter((relPath, data) => written.push([relPath, data]));

    expect(written).toEqual([["a.ts", "two"]]);
  });

  /** An emitter that throws is a socket that reports itself connected and is
   *  not. The write has to go back in the queue rather than vanish between the
   *  two states. */
  it("puts a write back when the emitter throws", () => {
    setWriteEmitter(() => {
      throw new Error("socket is lying");
    });
    queueWrite("a.ts", "one", 0);
    vi.advanceTimersByTime(0);

    expect(unsentPaths()).toEqual(["a.ts"]);
  });

  /** A deleted file must not come back — the reason `discardWrite` exists —
   *  and that has to reach the kept writes too, which are one layer further
   *  down than it used to look. */
  it("discards a kept write as well as a pending one", () => {
    setWriteEmitter(null);
    queueWrite("gone.ts", "one", 0);
    vi.advanceTimersByTime(0);
    expect(unsentPaths()).toEqual(["gone.ts"]);

    discardWrite("gone.ts");
    setWriteEmitter((relPath, data) => written.push([relPath, data]));

    expect(written).toEqual([]);
    expect(unsentPaths()).toEqual([]);
  });

  /** Renaming a file whose write is stranded offline has the same problem the
   *  pending case has: left alone it lands under the old name. */
  it("renames a kept write rather than losing it", () => {
    setWriteEmitter(null);
    queueWrite("old.ts", "typed", 0);
    vi.advanceTimersByTime(0);

    renameWrite("old.ts", "new.ts");
    setWriteEmitter((relPath, data) => written.push([relPath, data]));
    vi.advanceTimersByTime(0);

    expect(written).toEqual([["new.ts", "typed"]]);
  });
});

describe("the recovery record", () => {
  beforeEach(() => {
    localStorage.clear();
    setWriteScope("p1");
  });

  /** Written on the way IN, so the debounce window itself — the whole reason
   *  this module exists — is covered by it. */
  it("records a buffer the moment it is queued, before any timer", () => {
    queueWrite("a.ts", "typed", 800);

    expect(recoveredBuffers("p1").map((entry) => entry.relPath)).toEqual([
      "a.ts",
    ]);
    expect(recoveredBuffers("p1")[0]?.data).toBe("typed");
  });

  /** Cleared when the SERVER confirms and at no other point. Until then the
   *  only proof the edit survived is the copy in storage. */
  it("keeps the record until the server confirms the write", () => {
    queueWrite("a.ts", "typed", 0);
    vi.advanceTimersByTime(0);

    // Sent, but not yet acknowledged.
    expect(recoveredBuffers("p1")).toHaveLength(1);

    confirmWrite("a.ts");
    expect(recoveredBuffers("p1")).toEqual([]);
  });

  it("forgets a discarded file", () => {
    queueWrite("gone.ts", "typed", 800);
    discardWrite("gone.ts");

    expect(recoveredBuffers("p1")).toEqual([]);
  });

  /** No scope means no project to file it under, and a buffer filed under the
   *  wrong project would be offered back in the wrong workspace. */
  it("records nothing when no project is in scope", () => {
    setWriteScope(null);
    queueWrite("a.ts", "typed", 800);

    expect(recoveredBuffers("p1")).toEqual([]);
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
