import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  countsAgainstPublishBudget,
  createPublishLimiter,
} from "./publishBudget.js";
import { apiApp, bearer, TEST_PROJECT } from "../test/apiHarness.js";

/** Which visibility changes are rationed.
 *
 *  Forking was rate limited from the start, as project creation. Publishing
 *  never was -- and publishing is the action on that route whose cost lands on
 *  somebody other than the person taking it, because it puts a project in a
 *  gallery every signed-in user reads.
 */
describe("what the publishing budget counts", () => {
  it("counts a request to go public", () => {
    expect(countsAgainstPublishBudget({ visibility: "public" })).toBe(true);
  });

  /** The asymmetry is the design, not an oversight.
   *
   *  Making a project private again is the remedy for having published it.
   *  Somebody who has just realised their project holds something it should
   *  not must be able to take it down immediately, and a limiter shared with
   *  publishing would deny exactly that -- the person most likely to be at
   *  their limit is the person who has been publishing. A burst of
   *  un-publishing costs the gallery nothing.
   */
  it("never counts a request to go private", () => {
    expect(countsAgainstPublishBudget({ visibility: "private" })).toBe(false);
  });

  it("does not count a body it cannot read", () => {
    // The controller validates properly with zod; this only decides whether
    // to charge the budget. Charging for requests that were never going to
    // publish anything would let a stream of malformed bodies exhaust an
    // honest user's allowance -- a rate limiter turned into a denial of
    // service against its own user.
    expect(countsAgainstPublishBudget(undefined)).toBe(false);
    expect(countsAgainstPublishBudget(null)).toBe(false);
    expect(countsAgainstPublishBudget("public")).toBe(false);
    expect(countsAgainstPublishBudget({})).toBe(false);
    expect(countsAgainstPublishBudget({ visibility: 1 })).toBe(false);
    expect(countsAgainstPublishBudget([{ visibility: "public" }])).toBe(false);
  });

  it("matches the literal the controller's schema accepts", () => {
    // The route sends "public", not "PUBLIC" -- the enum is lowercase and the
    // Prisma constant is not. A predicate looking for the wrong spelling
    // silently counts nothing, which is a rate limit that is not there.
    expect(countsAgainstPublishBudget({ visibility: "PUBLIC" })).toBe(false);
    expect(countsAgainstPublishBudget({ visibility: "public" })).toBe(true);
  });
});

/** The limiter as it is actually mounted.
 *
 *  The predicate above is only half the design; `skip` inverts it. An inverted
 *  `skip` rations taking projects down and lets publishing run free -- exactly
 *  backwards, and invisible to every test of the predicate alone. So this
 *  mounts the real middleware and counts real requests.
 */
describe("the limiter on the visibility route", () => {
  function app() {
    return apiApp([
      {
        method: "patch",
        path: "/projects/:projectId/visibility",
        before: [createPublishLimiter()],
        handler: (_req, res) => {
          res.json({ success: true });
        },
      },
    ]);
  }

  async function patch(server: ReturnType<typeof app>, visibility: string) {
    return request(server)
      .patch(`/projects/${TEST_PROJECT}/visibility`)
      .set("Authorization", bearer())
      .send({ visibility });
  }

  it("stops a burst of publishing", async () => {
    const server = app();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await patch(server, "public")).status).toBe(200);
    }

    const refused = await patch(server, "public");
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe("RATE_LIMITED");
  });

  it("never stops somebody taking a project down", async () => {
    // The one that matters. Somebody who has just realised their public
    // project holds something it should not must be able to un-publish it
    // immediately -- and the person most likely to be at their limit is the
    // person who has been publishing. A shared budget would deny exactly the
    // request that fixes the problem.
    const server = app();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await patch(server, "public");
    }
    expect((await patch(server, "public")).status).toBe(429);

    for (let attempt = 0; attempt < 25; attempt += 1) {
      expect((await patch(server, "private")).status).toBe(200);
    }
  });

  it("does not let un-publishing eat the publishing budget", async () => {
    // The other direction of the same asymmetry: private requests are skipped
    // entirely, so they must not consume the allowance either.
    const server = app();

    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect((await patch(server, "private")).status).toBe(200);
    }

    expect((await patch(server, "public")).status).toBe(200);
  });
});
