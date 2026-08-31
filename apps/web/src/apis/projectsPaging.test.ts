// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Who follows a cursor, and who is handed one.
 *
 *  The dashboard's list is the only one of the four that follows its own
 *  pages, and the reason is not consistency but honesty: that screen searches
 *  and sorts the whole set in the browser, so a page break there would mean
 *  typing a project's name and being told it does not exist because it is on
 *  page two. Paging bounds the query; it must not silently bound the answer.
 */

const get = vi.hoisted(() => vi.fn());
vi.mock("../config/axiosConfig.ts", () => ({ default: { get } }));

import { listProjectsApi, listPublicProjectsApi } from "./projects.ts";

function page(items: unknown[], nextCursor: string | null = null) {
  return { data: { success: true, message: "Projects", data: { items, nextCursor } } };
}

function project(id: string) {
  return { id, name: id, template: "react-vite" };
}

beforeEach(() => {
  get.mockReset();
});

describe("the dashboard's own projects", () => {
  it("asks for one page when one page is all there is", async () => {
    get.mockResolvedValue(page([project("a")]));

    expect(await listProjectsApi()).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[1]).toEqual({ params: {} });
  });

  it("follows the cursor to the end and returns everything", async () => {
    get.mockResolvedValueOnce(page([project("a")], "a"));
    get.mockResolvedValueOnce(page([project("b")], "b"));
    get.mockResolvedValueOnce(page([project("c")]));

    const all = await listProjectsApi();

    expect(all.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(get.mock.calls[1]?.[1]).toEqual({ params: { cursor: "a" } });
    expect(get.mock.calls[2]?.[1]).toEqual({ params: { cursor: "b" } });
  });

  /** A client loop with no stop is a client loop that hangs on a server bug.
   *  Stopping is visibly wrong; spinning forever is invisibly wrong. */
  it("stops rather than looping forever on a cursor that never ends", async () => {
    get.mockResolvedValue(page([project("a")], "a"));

    await listProjectsApi();

    expect(get).toHaveBeenCalledTimes(20);
  });
});

describe("the gallery", () => {
  /** Handed to the caller instead, because this list grows with every public
   *  project on the machine and has no bound of its own. */
  it("returns the page and its cursor rather than following it", async () => {
    get.mockResolvedValue(page([project("a")], "a"));

    const result = await listPublicProjectsApi();

    expect(result.nextCursor).toBe("a");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("passes a cursor back when it is given one", async () => {
    get.mockResolvedValue(page([]));

    await listPublicProjectsApi("a");

    expect(get.mock.calls[0]?.[1]).toEqual({ params: { cursor: "a" } });
  });
});
