import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../utils/errors.js";
import { logger } from "../lib/logger.js";

export function notFoundHandler(_req: Request, res: Response): void {
  res
    .status(404)
    .json({ success: false, code: "NOT_FOUND", message: "Route not found" });
}

/** Terminal error middleware.
 *
 *  There was previously no error handler at all, so a rejected promise in a
 *  controller left the request hanging until the client timed out.
 */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (error instanceof ZodError) {
    res.status(400).json({
      success: false,
      code: "VALIDATION_ERROR",
      message: error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    });
    return;
  }

  // multer rejects an oversized or over-count upload with its own error type,
  // which would otherwise surface as a bare 500.
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: string }).name === "MulterError"
  ) {
    const code = (error as { code?: string }).code ?? "UPLOAD_FAILED";
    res.status(code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
      success: false,
      code,
      message:
        code === "LIMIT_FILE_SIZE"
          ? "That file is too large to upload"
          : "Could not accept that upload",
    });
    return;
  }

  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      success: false,
      code: error.code,
      message: error.message,
    });
    return;
  }

  logger.error("unhandled error", error);
  res.status(500).json({
    success: false,
    code: "INTERNAL_ERROR",
    message: "Something went wrong",
  });
}

/** Wraps an async handler so a rejection reaches errorHandler.
 *
 *  Express 4 does not await handlers; Express 5 does. Keep this until the
 *  upgrade.
 */
export function asyncHandler<
  P = Record<string, string>,
  ResBody = unknown,
  ReqBody = unknown,
>(
  handler: (
    req: Request<P, ResBody, ReqBody>,
    res: Response,
    next: NextFunction,
  ) => Promise<unknown>,
) {
  return (
    req: Request<P, ResBody, ReqBody>,
    res: Response,
    next: NextFunction,
  ): void => {
    void handler(req, res, next).catch(next);
  };
}
