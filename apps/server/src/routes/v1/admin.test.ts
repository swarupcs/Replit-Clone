import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// The assertion is load-bearing: without it every `settings[...]` below is an
// implicit `any` and typecheck fails. `no-unnecessary-type-assertion` reads
// the hoisted factory's return and disagrees, so the rule is turned off for
// this line rather than the file.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
const settings = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("../../config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/env.js")>();
  Object.assign(settings, actual.env, { ADMIN_EMAILS: "" });
  return { ...actual, env: settings };
});

/** The service is not what this file is about. Stubbed so that a request
 *  reaching the controller is unmistakable: anything that gets past the gate
 *  gets a 200 with a marker in it, and no database is involved. */
vi.mock("../../service/reportService.js", () => ({
  MAX_DETAILS: 2000,
  // A page, which is what every list here answers with now.
  listReports: () =>
    Promise.resolve({ items: [{ id: "let-through" }], nextCursor: null }),
  reviewReport: () => Promise.resolve({ id: "let-through" }),
  fileReport: () => Promise.resolve({ id: "let-through" }),
  findReport: () => Promise.resolve(null),
}));

import adminRouter from "./admin.js";
import { requireAuth } from "../../middlewares/requireAuth.js";
import { errorHandler } from "../../middlewares/errorHandler.js";
import { bearer, TEST_USER } from "../../test/apiHarness.js";

/** The operator's surface, as it is actually mounted.
 *
 *  Both guards, in order, are the whole security story of this router: without
 *  `requireAdmin` any signed-in account could un-publish anybody's project,
 *  and the middleware's own tests cannot see whether the router remembered to
 *  use it. So this mounts the real router and sends real requests through it.
 */
function app() {
  const server = express();
  server.use(express.json());
  // Exactly as routes/v1/index.ts mounts it.
  server.use("/admin", requireAuth, adminRouter);
  server.use(errorHandler);
  return server;
}

const ROUTES = [
  { method: "get" as const, path: "/admin/reports" },
  {
    method: "post" as const,
    path: "/admin/reports/2b1f5c8e-0000-4000-8000-000000000000/review",
  },
];

describe("the report queue behind both guards", () => {
  for (const route of ROUTES) {
    it(`refuses ${route.path} with no token`, async () => {
      settings["ADMIN_EMAILS"] = TEST_USER.email;

      const response = await request(app())[route.method](route.path);
      expect(response.status).toBe(401);
    });

    it(`refuses ${route.path} for a signed-in stranger`, async () => {
      settings["ADMIN_EMAILS"] = "someone-else@example.com";

      const response = await request(app())[route.method](route.path)
        .set("Authorization", bearer())
        .send({ decision: "ACTIONED" });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("NOT_ADMIN");
    });

    it(`refuses ${route.path} when no allowlist is configured`, async () => {
      settings["ADMIN_EMAILS"] = "";

      const response = await request(app())[route.method](route.path)
        .set("Authorization", bearer())
        .send({ decision: "ACTIONED" });

      expect(response.status).toBe(403);
    });
  }

  it("lets an operator read the queue", async () => {
    settings["ADMIN_EMAILS"] = TEST_USER.email;

    const response = await request(app())
      .get("/admin/reports")
      .set("Authorization", bearer());

    expect(response.status).toBe(200);
    expect(response.body.data.items).toEqual([{ id: "let-through" }]);
  });

  it("lets an operator review one", async () => {
    settings["ADMIN_EMAILS"] = TEST_USER.email;

    const response = await request(app())
      .post("/admin/reports/2b1f5c8e-0000-4000-8000-000000000000/review")
      .set("Authorization", bearer())
      .send({ decision: "ACTIONED" });

    expect(response.status).toBe(200);
    expect(response.body.message).toContain("private");
  });

  /** A decision the schema does not accept must not reach the service. The
   *  only two an operator has are dismiss and action; anything else is a
   *  request for an authority this surface deliberately does not grant. */
  it("refuses a decision that is not one of the two", async () => {
    settings["ADMIN_EMAILS"] = TEST_USER.email;

    const response = await request(app())
      .post("/admin/reports/2b1f5c8e-0000-4000-8000-000000000000/review")
      .set("Authorization", bearer())
      .send({ decision: "DELETE_PROJECT" });

    expect(response.status).toBe(400);
  });

  it("refuses a report id that is not one", async () => {
    settings["ADMIN_EMAILS"] = TEST_USER.email;

    const response = await request(app())
      .post("/admin/reports/not-a-uuid/review")
      .set("Authorization", bearer())
      .send({ decision: "ACTIONED" });

    expect(response.status).toBe(400);
  });
});
