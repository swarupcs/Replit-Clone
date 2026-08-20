import { beforeEach, describe, expect, it } from "vitest";
import { increment, registerGauge, resetMetrics, snapshot } from "./metrics.js";

beforeEach(() => {
  resetMetrics();
});

describe("metrics", () => {
  it("starts with nothing counted", () => {
    expect(snapshot()["runs_started"]).toBeUndefined();
  });

  it("counts occurrences", () => {
    increment("runs_started");
    increment("runs_started");
    increment("runs_failed");

    expect(snapshot()["runs_started"]).toBe(2);
    expect(snapshot()["runs_failed"]).toBe(1);
  });

  it("accepts a step other than one", () => {
    increment("preview_errors", 5);
    expect(snapshot()["preview_errors"]).toBe(5);
  });

  it("reads gauges at snapshot time, not registration time", () => {
    let live = 1;
    registerGauge("test_live", () => live);

    expect(snapshot()["test_live"]).toBe(1);
    live = 7;
    expect(snapshot()["test_live"]).toBe(7);
  });

  it("does not let a throwing gauge break the whole snapshot", () => {
    registerGauge("test_broken", () => {
      throw new Error("cannot read");
    });
    increment("runs_started");

    const result = snapshot();
    expect(result["test_broken"]).toBe(-1);
    // The rest must still be there — this feeds a health endpoint.
    expect(result["runs_started"]).toBe(1);
  });
});
