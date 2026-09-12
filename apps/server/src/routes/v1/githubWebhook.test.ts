import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";

/** The receiver for §13.3, tested at the route rather than at the handler.
 *
 *  §5 records why that distinction earned its own file: the billing webhook's
 *  tests proved its handler and never its mounting, and the mounting was the
 *  whole bug. So `webhookRawBody()` is mounted here exactly as `index.ts`
 *  mounts it, with `express.json()` in front of the router, which is the
 *  arrangement a real delivery meets.
 */

const SECRET = "webhook-secret";

const hoisted = vi.hoisted(() => {
  // Declared rather than asserted: the tests set it to undefined to exercise
  // the unconfigured branch, so the property has to be wider than its value.
  const secret: { value: string | undefined } = { value: "webhook-secret" };
  return { claimDelivery: vi.fn(), applyDecision: vi.fn(), secret };
});

vi.mock("../../service/prWorkspaceService.js", () => ({
  claimDelivery: hoisted.claimDelivery,
  applyDecision: hoisted.applyDecision,
}));

// The real module, with one field overridden. Replacing it wholesale breaks
// the logger, which reads `isProduction` from it.
vi.mock("../../config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/env.js")>();
  return {
    ...actual,
    get env() {
      return { ...actual.env, GITHUB_WEBHOOK_SECRET: hoisted.secret.value };
    },
  };
});

const { webhookRawBody } = await import("../../middlewares/webhookRawBody.js");
const { default: githubWebhookRouter } = await import("./githubWebhook.js");
const { errorHandler } = await import("../../middlewares/errorHandler.js");

/** Assembled the way `index.ts` assembles it: the raw parser, then the JSON
 *  one, then the routes. */
function app() {
  const instance = express();
  instance.use(webhookRawBody());
  instance.use(express.json());
  instance.use("/api/v1/github", githubWebhookRouter);
  instance.use(errorHandler);
  return instance;
}

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function post(
  body: string,
  options: { signature?: string; event?: string; delivery?: string } = {},
) {
  const call = request(app())
    .post("/api/v1/github/webhook")
    .set("content-type", "application/json")
    .set("x-github-event", options.event ?? "pull_request")
    .set("x-hub-signature-256", options.signature ?? sign(body));
  if (options.delivery !== undefined) call.set("x-github-delivery", options.delivery);
  return call.send(body);
}

const SHA = "b".repeat(40);
const BODY = JSON.stringify({
  action: "opened",
  repository: { name: "widget", owner: { login: "acme" } },
  pull_request: {
    number: 3,
    title: "t",
    head: { ref: "feature", sha: SHA, repo: { name: "widget", owner: { login: "acme" } } },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.secret.value = SECRET;
  hoisted.claimDelivery.mockResolvedValue(true);
  hoisted.applyDecision.mockResolvedValue("created");
});

describe("the GitHub webhook receiver", () => {
  it("acts on a correctly signed delivery", async () => {
    const response = await post(BODY, { delivery: "d-1" });

    expect(response.status).toBe(200);
    expect(hoisted.applyDecision).toHaveBeenCalledOnce();
  });

  it("reads the raw bytes through the app's real parser order", async () => {
    // The regression §5 records: with express.json() in front and only a
    // route-level express.raw, the body arrives parsed and every signature
    // fails. This test is the one that would go red again.
    const response = await post(BODY, { delivery: "d-raw" });
    expect(response.status).toBe(200);
  });

  it("refuses a forged signature", async () => {
    const response = await post(BODY, { delivery: "d-2", signature: sign(BODY, "wrong") });

    expect(response.status).toBe(400);
    expect(hoisted.applyDecision).not.toHaveBeenCalled();
  });

  it("never says which half of the check failed", async () => {
    const response = await post(BODY, { delivery: "d-3", signature: "sha256=abc" });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toMatch(/length|mismatch|timestamp|malformed/i);
  });

  it("refuses a delivery with no id, because that is the replay defence", async () => {
    // GitHub's signature has no timestamp, so a captured delivery stays valid
    // forever; the id is the only thing that makes a replay detectable.
    const response = await post(BODY);

    expect(response.status).toBe(400);
    expect(hoisted.applyDecision).not.toHaveBeenCalled();
  });

  it("does not act twice on a replayed delivery", async () => {
    hoisted.claimDelivery.mockResolvedValue(false);

    const response = await post(BODY, { delivery: "d-seen" });

    expect(response.status).toBe(200);
    expect(hoisted.applyDecision).not.toHaveBeenCalled();
  });

  it("answers a ping without claiming its id", async () => {
    // A re-ping after a reconfigure must not look like a replay.
    const response = await post(JSON.stringify({ zen: "hi" }), {
      event: "ping",
      delivery: "d-ping",
    });

    expect(response.status).toBe(200);
    expect(hoisted.claimDelivery).not.toHaveBeenCalled();
  });

  it("reports 503 when the deployment has no signing secret", async () => {
    hoisted.secret.value = undefined;

    const response = await post(BODY, { delivery: "d-4" });

    // 503 and not 404: the endpoint exists and is unconfigured, which is a
    // different thing in an App's delivery log.
    expect(response.status).toBe(503);
  });

  it("refuses unreadable JSON that is nonetheless correctly signed", async () => {
    const body = "{not json";
    const response = await post(body, { delivery: "d-5", signature: sign(body) });

    expect(response.status).toBe(400);
  });

  it("returns 200 for a delivery it does not act on, so GitHub stops retrying", async () => {
    hoisted.applyDecision.mockResolvedValue("ignored");

    const response = await post(BODY, { event: "issues", delivery: "d-6" });

    expect(response.status).toBe(200);
  });
});
