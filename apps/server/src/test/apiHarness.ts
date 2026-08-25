import { randomUUID } from "node:crypto";
import express from "express";
import type { Express, RequestHandler, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { asyncHandler, errorHandler } from "../middlewares/errorHandler.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { signAccessToken } from "../service/tokenService.js";

/** Mounts controllers the way the real routers do, minus the rate limiters.
 *
 *  The limiters are deliberately left out: they hold state for fifteen minutes
 *  across every test in a file, so a suite with more than a handful of cases
 *  starts failing on the budget rather than on the behaviour under test. What
 *  matters here is the controller plus the two middlewares that decide what a
 *  caller is allowed to do and what they are told when it goes wrong.
 */

export const TEST_USER = {
  sub: "11111111-1111-4111-8111-111111111111",
  email: "owner@example.com",
};

/** A project id nobody else is using.
 *
 *  Generated per test MODULE, not written down. Suites that exercise real path
 *  handling create a real directory under PROJECTS_DIR named after this, and
 *  vitest runs test files in parallel — so a fixed id meant one suite's
 *  teardown deleting another's fixtures mid-test, which surfaced as an upload
 *  failing with a 500 only when the whole workspace ran at once. Fresh per
 *  module, two suites can never name the same directory.
 */
export const TEST_PROJECT: string = randomUUID();

export function bearer(user: { sub: string; email: string } = TEST_USER): string {
  return `Bearer ${signAccessToken(user)}`;
}

type Method = "get" | "post" | "put" | "patch" | "delete";

export interface Route {
  method: Method;
  path: string;
  /** Controllers declare their own route-parameter shapes — `Request<{
   *  projectId: string }>` and so on — which do not unify with the
   *  ParamsDictionary an Express Router hands a handler. `never` accepts all of
   *  them, and the single cast in `apiApp` is what reconciles it, rather than
   *  one cast per route in every suite. */
  handler: (req: never, res: Response) => Promise<void> | void;
  /** Anything that must run between requireAuth and the controller. */
  before?: RequestHandler[];
}

export function apiApp(routes: Route[], { auth = true } = {}): Express {
  const app = express();

  app.use(cookieParser());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const router = express.Router();
  if (auth) router.use(requireAuth);

  for (const { method, path, handler, before = [] } of routes) {
    const wrapped = handler as unknown as (
      req: Request,
      res: Response,
    ) => Promise<void>;

    router[method](path, ...before, asyncHandler(wrapped));
  }

  app.use(router);
  app.use(errorHandler);

  return app;
}
