import type { Request, Response } from "express";
import { getAuthContext } from "../middlewares/requireAuth.js";
import {
  assertProjectAccess,
  getProjectAccess,
} from "../service/projectAccessService.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import { ConnectionRefused } from "../lib/connectionGuard.js";
import { BadRequestError } from "../utils/errors.js";
import {
  DatabaseQueryError,
  getConnection,
  introspect,
  removeConnection,
  runQuery,
  setConnection,
  tablePage,
} from "../service/databaseQueryService.js";
import {
  describe as describeManaged,
  destroy as destroyManaged,
  provision as provisionManaged,
} from "../service/managedDatabaseService.js";

/** Who may do what with a project's database.
 *
 *  Pointing a project at a database is the owner's call, and deliberately not
 *  an editor's: the connection string is a credential for a system outside
 *  this one, and "somebody was given write access to a file" is not the same
 *  decision as "somebody may name the database this project talks to".
 *
 *  Running a query is a viewer's business, because a viewer can already read
 *  every file — but only as a read-only session, and the database is what
 *  enforces that.
 */
async function authorise(
  req: Request,
  level: "viewer" | "editor" | "owner",
): Promise<string> {
  const { userId } = getAuthContext(req);
  const projectId = assertValidProjectId(req.params["projectId"] ?? "");
  await assertProjectAccess(projectId, userId, level);
  return projectId;
}

/** Whether this request may write.
 *
 *  Returned as a flag the service turns into `BEGIN READ ONLY`, rather than
 *  as a decision about which statements to allow: §7.5 is explicit that
 *  hiding a button is not a control and that classifying SQL is a losing
 *  game, so the refusal has to come from the database.
 */
async function mayWrite(req: Request, projectId: string): Promise<boolean> {
  const { userId } = getAuthContext(req);
  const access = await getProjectAccess(projectId, userId);
  return access?.level === "owner" || access?.level === "editor";
}

/** A request field, only if it really is a string.
 *
 *  A JSON body can send `{"sql": {}}`, and `String()` would turn that into
 *  "[object Object]" and hand it to the database as a statement. Anything
 *  that is not a string is treated as absent. */
function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function translate(error: unknown): never {
  if (error instanceof ConnectionRefused) {
    throw new BadRequestError(error.message, error.code);
  }
  if (error instanceof DatabaseQueryError) {
    throw new BadRequestError(error.message, error.code);
  }
  throw error;
}

export async function getDatabaseConnectionController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "viewer");
  res.json({
    success: true,
    message: "Database connection",
    // Engine and label only. The connection string never travels to the
    // client, so the client can never name a host of its own choosing.
    data: await getConnection(projectId),
  });
}

export async function setDatabaseConnectionController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "owner");
  const url = stringField((req.body as { url?: unknown }).url);

  if (!url.trim()) {
    throw new BadRequestError("A connection string is required.", "URL_REQUIRED");
  }

  try {
    res.json({
      success: true,
      message: "Database connected",
      data: await setConnection(projectId, url),
    });
  } catch (error) {
    translate(error);
  }
}

export async function removeDatabaseConnectionController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "owner");
  await removeConnection(projectId);
  res.json({ success: true, message: "Database disconnected", data: null });
}

export async function databaseSchemaController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "viewer");
  try {
    res.json({
      success: true,
      message: "Schema",
      data: await introspect(projectId),
    });
  } catch (error) {
    translate(error);
  }
}

export async function databaseQueryController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "viewer");
  const sql = stringField((req.body as { sql?: unknown }).sql);

  if (!sql.trim()) {
    throw new BadRequestError("A statement is required.", "SQL_REQUIRED");
  }

  try {
    res.json({
      success: true,
      message: "Query result",
      data: await runQuery(projectId, sql, {
        readOnly: !(await mayWrite(req, projectId)),
      }),
    });
  } catch (error) {
    translate(error);
  }
}

export async function databaseTableController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "viewer");
  const schema = stringField(req.query["schema"], "public");
  const table = stringField(req.query["table"]);
  const limit = Number(req.query["limit"] ?? 100);
  const offset = Number(req.query["offset"] ?? 0);

  if (!table) {
    throw new BadRequestError("A table is required.", "TABLE_REQUIRED");
  }

  try {
    res.json({
      success: true,
      message: "Table page",
      data: await tablePage(projectId, schema, table, {
        limit: Number.isFinite(limit) ? limit : 100,
        offset: Number.isFinite(offset) ? offset : 0,
      }),
    });
  } catch (error) {
    translate(error);
  }
}

/** The managed database — one this platform runs for the project.
 *
 *  Distinct from the external connection above: this one the client never
 *  names at all, because there is nothing to name. Provisioning and
 *  destroying are the owner's, for the same reason setting a connection
 *  string is — it costs a container slot on a shared VM.
 */
export async function getManagedDatabaseController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "viewer");
  res.json({
    success: true,
    message: "Managed database",
    data: await describeManaged(projectId),
  });
}

export async function provisionManagedDatabaseController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "owner");
  res.json({
    success: true,
    message: "Database provisioned",
    data: await provisionManaged(projectId),
  });
}

export async function destroyManagedDatabaseController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "owner");
  await destroyManaged(projectId);
  res.json({ success: true, message: "Database removed", data: null });
}
