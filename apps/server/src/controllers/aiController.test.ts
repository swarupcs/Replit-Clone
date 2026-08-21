import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const aiStatus = vi.hoisted(() => vi.fn());

vi.mock("../service/aiService.js", () => ({ aiStatus }));

import { aiStatusController } from "./aiController.js";
import { apiApp, bearer } from "../test/apiHarness.js";

const app = apiApp([{ method: "get", path: "/ai/status", handler: aiStatusController }]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("aiStatusController", () => {
  it("reports a configured assistant and which model answers", async () => {
    aiStatus.mockReturnValue({ configured: true, model: "claude-sonnet-5" });

    const response = await request(app).get("/ai/status").set("Authorization", bearer());

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ configured: true, model: "claude-sonnet-5" });
  });

  /** The web app hides the panel outright on this, rather than offering a
   *  feature that fails on the first question. */
  it("reports an unconfigured one without erroring", async () => {
    aiStatus.mockReturnValue({ configured: false, model: "claude-sonnet-5" });

    const response = await request(app).get("/ai/status").set("Authorization", bearer());

    expect(response.status).toBe(200);
    expect(response.body.data.configured).toBe(false);
  });

  it("is not readable without a credential", async () => {
    const response = await request(app).get("/ai/status");

    expect(response.status).toBe(401);
    expect(aiStatus).not.toHaveBeenCalled();
  });
});
