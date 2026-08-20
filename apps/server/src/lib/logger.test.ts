import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentRequestId,
  extendLogContext,
  logger,
  newRequestId,
  withLogContext,
} from "./logger.js";

function captureLines(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const record = (...args: unknown[]) => lines.push(args.map(String).join(" "));

  const log = vi.spyOn(console, "log").mockImplementation(record);
  const error = vi.spyOn(console, "error").mockImplementation(record);

  return {
    lines,
    restore: () => {
      log.mockRestore();
      error.mockRestore();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("log context", () => {
  it("has no request id outside a context", () => {
    expect(currentRequestId()).toBeUndefined();
  });

  it("carries the request id through the call", () => {
    const requestId = newRequestId();

    withLogContext({ requestId }, () => {
      expect(currentRequestId()).toBe(requestId);
    });
  });

  it("survives an await, which is the whole point", async () => {
    const requestId = newRequestId();

    await withLogContext({ requestId }, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentRequestId()).toBe(requestId);
    });
  });

  it("keeps concurrent requests apart", async () => {
    const seen: string[] = [];

    const run = (requestId: string, delay: number) =>
      withLogContext({ requestId }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        seen.push(currentRequestId() ?? "none");
      });

    // The slower one finishes second but must still report its own id.
    await Promise.all([run("first", 20), run("second", 1)]);

    expect(seen).toEqual(["second", "first"]);
  });

  it("does not leak a context out of its call", () => {
    withLogContext({ requestId: "inner" }, () => undefined);
    expect(currentRequestId()).toBeUndefined();
  });

  it("can be extended once the user is known", () => {
    withLogContext({ requestId: "r1" }, () => {
      extendLogContext({ userId: "u1" });

      const { lines, restore } = captureLines();
      logger.info("after auth");
      restore();

      expect(lines.join("\n")).toContain("after auth");
    });
  });
});

describe("logger output", () => {
  it("writes warnings and errors to stderr, and info to stdout", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logger.info("an info line");
    logger.warn("a warning");
    logger.error("a failure");

    expect(log).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("includes an error's message", () => {
    const { lines, restore } = captureLines();
    logger.error("could not connect", new Error("ECONNREFUSED"));
    restore();

    expect(lines.join("\n")).toContain("ECONNREFUSED");
  });

  it("includes structured fields", () => {
    const { lines, restore } = captureLines();
    logger.info("container started", { projectId: "p1", image: "sandbox-node" });
    restore();

    expect(lines.join("\n")).toContain("sandbox-node");
  });
});
