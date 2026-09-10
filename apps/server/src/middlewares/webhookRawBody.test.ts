import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { WEBHOOK_RAW_PATHS, webhookRawBody } from "./webhookRawBody.js";

/** The bug this file exists for.
 *
 *  `billing.ts` mounts `express.raw` on its own route and explains in a comment
 *  why the raw bytes matter. `index.ts` mounts `express.json()` globally in
 *  front of the entire API. The second wins, because body-parser marks the
 *  request handled and every later parser skips — so the route saw a parsed
 *  object, `Buffer.isBuffer(req.body)` was false, the raw string was `""`, and
 *  the signature check failed on every genuine delivery.
 *
 *  `billing.test.ts` could not catch it: its app is built without the global
 *  parser, with a comment claiming that matches the real one. So the tests here
 *  assemble the app the way `index.ts` actually assembles it, which is the only
 *  arrangement in which the bug is visible.
 */

/** Built in `index.ts`'s order: the raw parser, then the JSON one, then the
 *  routes. */
function realOrder() {
  const app = express();
  app.use(webhookRawBody());
  app.use(express.json());
  app.use("/api/v1/billing/webhook", (req, res) => {
    res.json({
      isBuffer: Buffer.isBuffer(req.body),
      raw: Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "",
    });
  });
  app.use("/api/v1/projects", (req, res) => {
    res.json({ body: req.body as unknown });
  });
  return app;
}

const BODY = '{"id":"evt_1","type":"customer.subscription.updated"}';

describe("a webhook body reaching the route as bytes", () => {
  it("survives the global JSON parser mounted in front of the API", async () => {
    const response = await request(realOrder())
      .post("/api/v1/billing/webhook")
      .set("content-type", "application/json")
      .send(BODY);

    expect(response.body.isBuffer).toBe(true);
  });

  it("arrives byte for byte, because that is what the signature covers", async () => {
    const response = await request(realOrder())
      .post("/api/v1/billing/webhook")
      .set("content-type", "application/json")
      .send(BODY);

    // Not `toEqual` on a parsed object: a re-stringified body compares equal
    // and hashes differently, which is exactly the failure being guarded.
    expect(response.body.raw).toBe(BODY);
  });

  it("leaves an ordinary route its parsed JSON", async () => {
    const response = await request(realOrder())
      .post("/api/v1/projects")
      .set("content-type", "application/json")
      .send(JSON.stringify({ name: "demo" }));

    expect(response.body.body).toEqual({ name: "demo" });
  });

  it("ignores a query string when matching the path", async () => {
    const response = await request(realOrder())
      .post("/api/v1/billing/webhook?attempt=2")
      .set("content-type", "application/json")
      .send(BODY);

    expect(response.body.isBuffer).toBe(true);
  });

  it("does not treat a path merely starting with a webhook path as one", async () => {
    const app = express();
    app.use(webhookRawBody());
    app.use(express.json());
    app.use("/api/v1/billing/webhookery", (req, res) => {
      res.json({ isBuffer: Buffer.isBuffer(req.body) });
    });

    const response = await request(app)
      .post("/api/v1/billing/webhookery")
      .set("content-type", "application/json")
      .send(BODY);

    expect(response.body.isBuffer).toBe(false);
  });

  it("lists the GitHub receiver, which has the same requirement", () => {
    // A webhook that is not on this list is a webhook whose signature check
    // cannot pass, so the list is asserted rather than assumed.
    expect(WEBHOOK_RAW_PATHS).toContain("/api/v1/github/webhook");
  });
});
