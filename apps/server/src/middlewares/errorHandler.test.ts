import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { asyncHandler, errorHandler, notFoundHandler } from "./errorHandler.js";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../utils/errors.js";

vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

interface Captured {
  status: number;
  body: unknown;
}

/** The two methods errorHandler actually uses, recording what it produced. */
function fakeRes(): Response & { captured: Captured } {
  const captured: Captured = { status: 200, body: undefined };

  const res = {
    captured,
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  };

  return res as unknown as Response & { captured: Captured };
}

function handle(error: unknown): Captured {
  const res = fakeRes();
  errorHandler(error, {} as Request, res, (() => undefined) as NextFunction);
  return res.captured;
}

/** Shaped like the error multer throws — it is not exported for construction. */
function multerError(code: string): Error {
  const error = new Error(code);
  error.name = "MulterError";
  (error as Error & { code: string }).code = code;
  return error;
}

describe("errorHandler", () => {
  it.each([
    [new BadRequestError("nope"), 400, "BAD_REQUEST"],
    [new UnauthorizedError(), 401, "UNAUTHORIZED"],
    [new ForbiddenError(), 403, "FORBIDDEN"],
    [new NotFoundError(), 404, "NOT_FOUND"],
    [new ConflictError(), 409, "CONFLICT"],
    [new AppError(503, "AT_CAPACITY", "Server is busy"), 503, "AT_CAPACITY"],
  ])("relays a %s as its own status and code", (error, status, code) => {
    const captured = handle(error);

    expect(captured.status).toBe(status);
    expect(captured.body).toMatchObject({
      success: false,
      code,
      message: error.message,
    });
  });

  it("turns a ZodError into a 400 naming the offending fields", () => {
    const schema = z.object({ name: z.string().min(3), age: z.number() });
    const result = schema.safeParse({ name: "a", age: "x" });

    if (result.success) throw new Error("expected the schema to reject this");
    const captured = handle(result.error);

    expect(captured.status).toBe(400);
    expect(captured.body).toMatchObject({
      success: false,
      code: "VALIDATION_ERROR",
    });
    expect((captured.body as { message: string }).message).toContain("name");
    expect((captured.body as { message: string }).message).toContain("age");
  });

  it("reports an oversized upload as 413 rather than a bare 500", () => {
    const captured = handle(multerError("LIMIT_FILE_SIZE"));

    expect(captured.status).toBe(413);
    expect(captured.body).toMatchObject({
      code: "LIMIT_FILE_SIZE",
      message: "That file is too large to upload",
    });
  });

  it("reports other multer failures as 400", () => {
    const captured = handle(multerError("LIMIT_FILE_COUNT"));

    expect(captured.status).toBe(400);
    expect(captured.body).toMatchObject({ code: "LIMIT_FILE_COUNT" });
  });

  /** The point of AppError: everything else is assumed to carry internals. */
  it("does not leak the message of an unexpected error", () => {
    const captured = handle(new Error("connect ECONNREFUSED 10.0.0.4:5432"));

    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({
      success: false,
      code: "INTERNAL_ERROR",
      message: "Something went wrong",
    });
  });

  it.each([[undefined], [null], ["a bare string"], [42]])(
    "still answers when thrown a non-Error (%s)",
    (thrown) => {
      const captured = handle(thrown);

      expect(captured.status).toBe(500);
      expect(captured.body).toMatchObject({ code: "INTERNAL_ERROR" });
    },
  );
});

describe("notFoundHandler", () => {
  it("answers 404 with a machine-readable code", () => {
    const res = fakeRes();
    notFoundHandler({} as Request, res);

    expect(res.captured.status).toBe(404);
    expect(res.captured.body).toEqual({
      success: false,
      code: "NOT_FOUND",
      message: "Route not found",
    });
  });
});

describe("asyncHandler", () => {
  it("forwards a rejection to next, so it reaches errorHandler", async () => {
    const next = vi.fn();
    const failure = new BadRequestError("bad");

    asyncHandler(() => Promise.reject(failure))({} as Request, fakeRes(), next);
    await vi.waitFor(() => {
      expect(next).toHaveBeenCalledWith(failure);
    });
  });

  /** Documents the boundary rather than a defect: `.catch(next)` can only see a
   *  rejection, so a handler that throws before returning its promise throws
   *  straight out of here. Express catches a synchronous throw from a
   *  middleware itself and routes it to errorHandler, so it still lands in the
   *  right place — but nothing else may be assumed about it. */
  it("lets a synchronous throw propagate for Express to catch", () => {
    const next = vi.fn();

    expect(() =>
      asyncHandler(() => {
        throw new Error("sync throw");
      })({} as Request, fakeRes(), next),
    ).toThrow("sync throw");

    expect(next).not.toHaveBeenCalled();
  });

  it("leaves next alone when the handler resolves", async () => {
    const next = vi.fn();
    const handler = vi.fn().mockResolvedValue(undefined);

    asyncHandler(handler)({} as Request, fakeRes(), next);
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledOnce();
    });

    expect(next).not.toHaveBeenCalled();
  });
});
