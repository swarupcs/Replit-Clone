import { describe, expect, it, vi } from "vitest";
import { installProblems, toProblems, type RawMarker } from "./problems.ts";

/** Monaco's severity numbers. */
const ERROR = 8;
const WARNING = 4;
const INFO = 2;
const HINT = 1;

function marker(overrides: Partial<RawMarker> = {}): RawMarker {
  return {
    resource: { path: "/src/App.tsx" },
    message: "something is wrong",
    severity: ERROR,
    startLineNumber: 3,
    startColumn: 5,
    ...overrides,
  };
}

describe("toProblems", () => {
  it("turns a marker's URI path back into the file's path", () => {
    // Models are keyed by an inmemory URI whose path is the relPath with a
    // leading slash; nothing outside the editor knows or wants that.
    expect(toProblems([marker()])[0]?.relPath).toBe("src/App.tsx");
  });

  it("carries the position and the message across", () => {
    expect(toProblems([marker()])[0]).toMatchObject({
      line: 3,
      column: 5,
      message: "something is wrong",
      severity: "error",
    });
  });

  it("names the language service when the marker does", () => {
    expect(toProblems([marker({ source: "ts" })])[0]?.source).toBe("ts");
    expect(toProblems([marker()])[0]?.source).toBeUndefined();
  });

  it("drops hints, which are affordances rather than problems", () => {
    // "This import is unused, click to remove" is a hint. A Problems list that
    // carried them would be mostly noise.
    expect(toProblems([marker({ severity: HINT })])).toEqual([]);
  });

  it("drops the diff editor's own models", () => {
    // The diff editor creates models with generated `inmemory://model/N` URIs.
    // A marker on one of those belongs to no file the user could open.
    expect(toProblems([marker({ resource: { path: "/model/1" } })])).toEqual([]);
  });

  it("reads worst first, then by file, then by position", () => {
    const problems = toProblems([
      marker({ severity: WARNING, resource: { path: "/a.ts" } }),
      marker({ severity: ERROR, resource: { path: "/z.ts" }, startLineNumber: 9 }),
      marker({ severity: ERROR, resource: { path: "/z.ts" }, startLineNumber: 2 }),
      marker({ severity: INFO, resource: { path: "/a.ts" } }),
    ]);

    expect(
      problems.map((problem) => [problem.severity, problem.relPath, problem.line]),
    ).toEqual([
      ["error", "z.ts", 2],
      ["error", "z.ts", 9],
      ["warning", "a.ts", 3],
      ["info", "a.ts", 3],
    ]);
  });
});

describe("installProblems", () => {
  /** A stand-in for the slice of monaco this uses. */
  function fakeMonaco(markers: RawMarker[]) {
    let listener: (() => void) | undefined;
    return {
      disposed: false,
      editor: {
        onDidChangeMarkers: (handler: () => void) => {
          listener = handler;
          return {
            dispose: () => {
              listener = undefined;
            },
          };
        },
        getModelMarkers: () => markers,
      },
      /** Announces a change the way Monaco does. */
      fire: () => listener?.(),
      get listening() {
        return listener !== undefined;
      },
    };
  }

  it("publishes what is already there, without waiting for a change", () => {
    // Markers for models that exist have been computed already, and there will
    // be no event for them.
    const monaco = fakeMonaco([marker()]);
    const publish = vi.fn();

    installProblems(monaco, publish);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toHaveLength(1);
  });

  it("re-reads the whole set on every change", () => {
    const markers = [marker()];
    const monaco = fakeMonaco(markers);
    const publish = vi.fn();

    installProblems(monaco, publish);
    // A marker going away is as meaningful as one arriving, and there is no
    // "removed" event to hang that on — so the set is re-read, not patched.
    markers.length = 0;
    monaco.fire();

    expect(publish.mock.calls.at(-1)?.[0]).toEqual([]);
  });

  it("stops listening when disposed", () => {
    const monaco = fakeMonaco([]);
    const dispose = installProblems(monaco, vi.fn());

    expect(monaco.listening).toBe(true);
    dispose();
    expect(monaco.listening).toBe(false);
  });
});
