import path from "node:path";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Searching every project an account owns.
 *
 *  `searchProject` was the only exported search in this module, so every
 *  search in this product was inside one project — and "which project did I
 *  write that in" is the one question that cannot answer. These tests are
 *  about the three things that are not the matching itself, which
 *  `searchService.test.ts` already covers: what is in scope, what a limit does
 *  to the answer, and what one broken project does to the other twenty-four.
 *
 *  Stubbed at the WORKER and not at `searchProject`. `searchAcrossProjects`
 *  calls its neighbour through the module's own binding, which a partial
 *  self-mock cannot intercept — so mocking `searchProject` silently tested
 *  nothing while appearing to work. Going one level lower also means the real
 *  fan-out, the real per-project call and the real error handling all run.
 */

const findMany = vi.hoisted(() => vi.fn());
vi.mock("../lib/prisma.js", () => ({
  prisma: { project: { findMany } },
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/metrics.js", () => ({ increment: vi.fn() }));

/** What the worker will report for each project root, by project id. */
const scripted = vi.hoisted(
  () => new Map<string, { matches: unknown[]; truncated: boolean } | "throw">(),
);

vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    terminate = () => Promise.resolve(0);

    constructor(_url: URL, options: { workerData: { root: string } }) {
      super();
      // `projectRoot` is PROJECTS_ROOT/<id>, so the id is the basename.
      const id = path.basename(options.workerData.root);
      const plan = scripted.get(id) ?? { matches: [], truncated: false };

      // Asynchronously, as a real worker answers — the fan-out's concurrency
      // is only exercised if the calls actually yield.
      setImmediate(() => {
        if (plan === "throw") this.emit("error", new Error("no working tree"));
        else this.emit("message", plan);
      });
    }
  },
}));

const { searchAcrossProjects } = await import("./searchService.js");

/** Ids have to be real uuids: `projectRoot` validates them. */
function id(index: number): string {
  return `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

function projects(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: id(index),
    name: `Project ${String(index)}`,
  }));
}

function matches(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    relPath: `file${String(index)}.ts`,
    line: 1,
    column: 1,
    preview: "needle",
  }));
}

/** What the worker answers for one project. */
function found(index: number, count: number, truncated = false) {
  scripted.set(id(index), { matches: matches(count), truncated });
}

beforeEach(() => {
  vi.clearAllMocks();
  scripted.clear();
  findMany.mockResolvedValue(projects(3));
  for (let index = 0; index < 40; index++) found(index, 1);
});

describe("what is in scope", () => {
  /** Owned, not merely accessible. A global search box reaching into projects
   *  shared WITH you would quietly widen how far one keystroke sees. */
  it("asks only for projects the account owns, and not deleted ones", async () => {
    await searchAcrossProjects("u1", { query: "needle" });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ownerId: "u1", deletedAt: null } }),
    );
  });

  it("does nothing at all for an empty query", async () => {
    const result = await searchAcrossProjects("u1", { query: "   " });

    expect(result).toEqual({
      projects: [],
      scanned: 0,
      total: 0,
      truncated: false,
    });
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("the answer", () => {
  /** The question was which project, so the project with three matches is a
   *  better answer than the one with a single match, whatever order the
   *  database returned them in. */
  it("puts the project with the most matches first", async () => {
    found(0, 1);
    found(1, 3);
    found(2, 2);

    const result = await searchAcrossProjects("u1", { query: "needle" });

    expect(result.projects.map((entry) => entry.matches.length)).toEqual([
      3, 2, 1,
    ]);
  });

  /** A path is not enough to place a result: "src/index.ts" is in most of
   *  somebody's projects. */
  it("names each project, not just its id", async () => {
    found(0, 5);

    const result = await searchAcrossProjects("u1", { query: "needle" });

    expect(result.projects[0]?.name).toBe("Project 0");
    expect(result.projects[0]?.projectId).toBe(id(0));
  });

  it("leaves out a project that matched nothing", async () => {
    found(1, 0);

    const result = await searchAcrossProjects("u1", { query: "needle" });

    expect(result.projects).toHaveLength(2);
    // Still counted as looked at, or "scanned 2 of 3" would mean a project was
    // skipped rather than searched and found wanting.
    expect(result.scanned).toBe(3);
  });
});

describe("when it cannot look everywhere", () => {
  /** Twenty-five is the cap. Somebody with two hundred projects asking for
   *  "TODO" gets a fast partial answer rather than a slow complete one — but
   *  it has to SAY it is partial, or a missing result reads as proof the text
   *  is nowhere. */
  it("stops at the cap and says the answer is partial", async () => {
    findMany.mockResolvedValue(projects(40));

    const result = await searchAcrossProjects("u1", { query: "needle" });

    expect(result.scanned).toBe(25);
    expect(result.total).toBe(40);
    expect(result.truncated).toBe(true);
  });

  it("is not partial when it did look everywhere", async () => {
    const result = await searchAcrossProjects("u1", { query: "needle" });

    expect(result.truncated).toBe(false);
    expect(result.scanned).toBe(result.total);
  });

  /** §5 has found two rows whose working tree does not exist. Without this one
   *  of them would break every cross-project search for as long as it existed,
   *  and it would break it as "that text is nowhere" rather than as an error. */
  it("skips a project that cannot be searched and keeps going", async () => {
    scripted.set(id(0), "throw");

    const result = await searchAcrossProjects("u1", { query: "needle" });

    expect(result.projects).toHaveLength(2);
    expect(result.scanned).toBe(3);
  });

  /** One project's own cap being hit is not the same as the whole search
   *  stopping early, and conflating them would tell a user to narrow a search
   *  that was in fact complete. */
  it("carries a single project's truncation without claiming the search was cut short", async () => {
    found(0, 1, true);

    const result = await searchAcrossProjects("u1", { query: "needle" });

    expect(result.projects.some((entry) => entry.truncated)).toBe(true);
    expect(result.truncated).toBe(false);
  });
});
