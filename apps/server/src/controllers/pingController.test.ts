import request from "supertest";
import { describe, expect, it } from "vitest";
import { pingCheck } from "./pingController.js";
import { apiApp } from "../test/apiHarness.js";

const app = apiApp([{ method: "get", path: "/ping", handler: pingCheck }], {
  auth: false,
});

describe("pingCheck", () => {
  /** Liveness only, and deliberately trivial. It is kept because things may
   *  already point at it; /health is the one that checks the dependencies. */
  it("answers 200 with a pong and nothing else", async () => {
    const response = await request(app).get("/ping");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "pong" });
  });

  it("needs no credential", async () => {
    const response = await request(app).get("/ping").set("Authorization", "Bearer nope");

    expect(response.status).toBe(200);
  });
});
