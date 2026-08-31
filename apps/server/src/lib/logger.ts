import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isProduction } from "../config/env.js";

/** Structured logging.
 *
 *  Everything used to be bare `console.log` / `console.error` with no request
 *  id, so a user reporting "it failed" left nothing to trace: the lines for
 *  their request were interleaved with everyone else's and could not be told
 *  apart.
 *
 *  Production emits one JSON object per line, which any log pipeline can parse.
 *  Development stays human-readable, because a wall of JSON is worse than
 *  useless when you are reading it directly in a terminal.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MIN_LEVEL: LogLevel = isProduction ? "info" : "debug";

/** Fields carried by everything logged inside a given request or socket. */
export interface LogContext {
  requestId: string;
  userId?: string;
  projectId?: string;
  /** Which API key made the request, when one did. After an incident the
   *  question is which credential did it, and an account id cannot answer
   *  that — an account may hold ten keys and revoking all of them is not the
   *  same thing as revoking the one that leaked. */
  apiKeyId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with a logging context every log line inside it inherits. */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Adds to the current context, if there is one. */
export function extendLogContext(fields: Partial<LogContext>): void {
  const current = storage.getStore();
  if (current) Object.assign(current, fields);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function newRequestId(): string {
  return randomUUID();
}

/** Anything an Error carries that is worth keeping, without the noise. */
function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      error: error.message,
      errorName: error.name,
      // Stacks are the point of an error log, but they are also most of its
      // bulk; development already prints them separately below.
      ...(isProduction ? { stack: error.stack } : {}),
    };
  }

  return { error: String(error) };
}

function emit(
  level: LogLevel,
  message: string,
  fields: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;

  const context = storage.getStore();
  const record = {
    level,
    time: new Date().toISOString(),
    message,
    ...(context ? { ...context } : {}),
    ...fields,
  };

  const stream = level === "error" || level === "warn" ? console.error : console.log;

  if (isProduction) {
    stream(JSON.stringify(record));
    return;
  }

  // Development: one readable line, with the context that actually helps.
  const tags = [
    context?.requestId ? context.requestId.slice(0, 8) : undefined,
    context?.projectId ? `project=${context.projectId.slice(0, 8)}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  const extra = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
  stream(`${level.toUpperCase().padEnd(5)} ${tags ? `[${tags}] ` : ""}${message}${extra}`);
}

export const logger = {
  debug: (message: string, fields: Record<string, unknown> = {}) => {
    emit("debug", message, fields);
  },
  info: (message: string, fields: Record<string, unknown> = {}) => {
    emit("info", message, fields);
  },
  warn: (message: string, fields: Record<string, unknown> = {}) => {
    emit("warn", message, fields);
  },
  error: (
    message: string,
    error?: unknown,
    fields: Record<string, unknown> = {},
  ) => {
    emit("error", message, { ...fields, ...(error ? describeError(error) : {}) });
    // Outside production the stack is worth more than the JSON, so print it.
    if (!isProduction && error instanceof Error && error.stack) {
      console.error(error.stack);
    }
  },
};
