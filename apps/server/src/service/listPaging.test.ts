import { beforeEach, describe, expect, it, vi } from "vitest";

/** How the four lists ask the database for a page.
 *
 *  Three properties, and each has a plausible wrong version that a screen
 *  would not reveal for months:
 *
 *  1. **One row more than the page** is read, because that is what turns "is
 *     there another page" into a fact rather than a guess.
 *  2. **The order breaks ties on `id`.** A cursor into an unstable order skips
 *     rows and repeats others, and `createdAt` alone is not stable: one
 *     project reported by two people at once shares a millisecond.
 *  3. **The cursor skips the row it names**, or every page begins with the
 *     last row of the one before it.
 */

const findMany = vi.hoisted(() => vi.fn());

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    projectReport: { findMany },
    moderationAction: { findMany },
    project: { findMany },
  },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { listReports } from "./reportService.js";
import { listRecentModeration } from "./moderationLogService.js";
import {
  listAccessibleProjects,
  listPublicProjects,
} from "./projectAccessService.js";

/** Rows shaped enough for each service's mapper to survive them. */
function rows(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `r${String(index)}`,
    projectId: "p1",
    project: { name: "P", owner: { email: "a@b.c" } },
    reporter: { email: "r@b.c" },
    reason: "SECRETS",
    status: "OPEN",
    details: null,
    createdAt: new Date("2026-08-31T00:00:00.000Z"),
    reviewedAt: null,
    reviewedBy: null,
    action: "TAKEN_DOWN",
    projectName: "P",
    actor: "op@b.c",
    name: "P",
    template: "react-vite",
    owner: { email: "a@b.c" },
    _count: { forks: 0 },
  }));
}

function lastQuery(): {
  take: number;
  orderBy: unknown;
  cursor?: { id: string };
  skip?: number;
} {
  return findMany.mock.calls.at(-1)?.[0] as ReturnType<typeof lastQuery>;
}

/** Every list this file is about, called the same way. */
const LISTS: [string, (page: { cursor?: string; limit?: number }) => Promise<unknown>][] = [
  ["the report queue", (page) => listReports("OPEN", undefined, page)],
  ["the moderation log", (page) => listRecentModeration(page)],
  ["the gallery", (page) => listPublicProjects(page)],
  ["a user's own projects", (page) => listAccessibleProjects("u1", page)],
];

beforeEach(() => {
  findMany.mockReset().mockResolvedValue([]);
});

describe.each(LISTS)("%s", (_name, list) => {
  it("reads one row more than it was asked for", async () => {
    await list({ limit: 10 });

    expect(lastQuery().take).toBe(11);
  });

  it("orders by something that cannot tie", async () => {
    await list({ limit: 10 });

    // An array of two keys, the second of them `id`. A single `createdAt` is
    // the version that looks right and pages wrongly.
    expect(lastQuery().orderBy).toEqual([
      expect.objectContaining({ createdAt: expect.any(String) }),
      { id: "desc" },
    ]);
  });

  it("asks for no cursor on the first page", async () => {
    await list({});

    expect(lastQuery().cursor).toBeUndefined();
    expect(lastQuery().skip).toBeUndefined();
  });

  it("steps past the row the cursor names", async () => {
    await list({ cursor: "r9", limit: 10 });

    expect(lastQuery().cursor).toEqual({ id: "r9" });
    expect(lastQuery().skip).toBe(1);
  });

  it("hands back a cursor only when there was another row", async () => {
    findMany.mockResolvedValue(rows(11));
    const full = (await list({ limit: 10 })) as { items: unknown[]; nextCursor: string | null };

    expect(full.items).toHaveLength(10);
    expect(full.nextCursor).toBe("r9");

    findMany.mockResolvedValue(rows(3));
    const short = (await list({ limit: 10 })) as { nextCursor: string | null };

    expect(short.nextCursor).toBeNull();
  });
});

/** What the dashboard is allowed to know about a project.
 *
 *  `listAccessibleProjects` selects an explicit column list rather than
 *  returning the row — deliberately, because a `Project` carries share tokens
 *  and env var names that read-only access is not access to. The cost of that
 *  choice is that adding a column anywhere else does not add it here, and
 *  nothing says so.
 *
 *  That is exactly how `scaffoldStatus` came to be added to the schema, to the
 *  API type and to three places in the dashboard, and then left out of this
 *  select: the client never received it, the poll never started, and a project
 *  still being built rendered as an ordinary card that opened onto an empty
 *  editor. Nothing failed — the feature was inert.
 *
 *  `ListedProject` now declares it as required, so an omitted key stops
 *  compiling. This is the same rule stated where a reader will meet it.
 */
describe("the dashboard's view of a project", () => {
  it("asks for the scaffold status, which decides whether a card opens", async () => {
    await listAccessibleProjects("u1", {});

    const query = findMany.mock.calls.at(-1)?.[0] as {
      select: Record<string, boolean>;
    };

    expect(query.select["scaffoldStatus"]).toBe(true);
  });

  /** The reason for the select in the first place. If this ever passes, a
   *  read-only collaborator can mint a link at their own role. */
  it("still asks for nothing that read-only access does not carry", async () => {
    await listAccessibleProjects("u1", {});

    const query = findMany.mock.calls.at(-1)?.[0] as {
      select: Record<string, boolean>;
    };

    for (const secret of ["shareToken", "embedToken", "envVars"]) {
      expect(query.select[secret]).toBeUndefined();
    }
  });
});
