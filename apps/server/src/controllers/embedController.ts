import type { Request, Response } from "express";
import { z } from "zod";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertProjectAccess } from "../service/projectAccessService.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import {
  createEmbed,
  embedFile,
  embedPayload,
  embedState,
  revokeEmbed,
  updateEmbed,
} from "../service/embedService.js";

/** The owner's endpoints sit behind auth; the reader's two do not.
 *
 *  They are in one file because they are one feature and the asymmetry between
 *  them is the thing worth reading in a single place: everything above the
 *  divider asks who you are, and everything below it deliberately does not.
 */

/** Creating an embed is the OWNER's decision and not an editor's, for the same
 *  reason publishing a deployment is: it is the action that puts a project's
 *  source in front of the entire internet, and "was given write access to a
 *  file" is not the same consent as "may publish this".
 *
 *  Reading the state is a viewer's business, so a collaborator can see that an
 *  embed exists at all.
 */
async function authorise(
  req: Request,
  level: "viewer" | "owner",
): Promise<string> {
  const { userId } = getAuthContext(req);
  const projectId = assertValidProjectId(req.params["projectId"] ?? "");
  await assertProjectAccess(projectId, userId, level);
  return projectId;
}

const settingsSchema = z.object({
  view: z.enum(["code", "preview", "split"]).optional(),
  preview: z.enum(["none", "deployment"]).optional(),
  activeFile: z.string().nullable().optional(),
});

export async function getEmbedController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "viewer");
  res.json({
    success: true,
    message: "Embed",
    data: await embedState(projectId),
  });
}

export async function createEmbedController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "owner");
  const settings = settingsSchema.parse(req.body ?? {});

  res.json({
    success: true,
    // Said outright. An owner replacing a token has just broken every page that
    // already carries the old one, and finding that out from a reader is worse
    // than being told here.
    message:
      "Embed created. Any snippet pasted earlier no longer works — copy the " +
      "new one.",
    data: await createEmbed(projectId, settings),
  });
}

export async function updateEmbedController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "owner");
  const settings = settingsSchema.parse(req.body ?? {});

  res.json({
    success: true,
    // Distinct from the message above, because the distinction is the whole
    // reason this endpoint exists separately.
    message: "Updated. Snippets already pasted show the change.",
    data: await updateEmbed(projectId, settings),
  });
}

export async function revokeEmbedController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "owner");

  res.json({
    success: true,
    message: "Embed revoked. Pages carrying it now show nothing.",
    data: await revokeEmbed(projectId),
  });
}

/* ---- below here, nobody is signed in ---------------------------------- */

/** Headers every anonymous embed response carries.
 *
 *  `no-store` because an embed's whole job is to be framed by a page the
 *  platform does not control, and a shared cache holding a project's source
 *  after the owner revoked the token would keep it readable long past the
 *  moment they decided it should not be. `nosniff` because these responses
 *  carry a project's own file contents, and a browser guessing that a `.json`
 *  of user text is really HTML is exactly the guess not to allow.
 */
function publicHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

export async function readEmbedController(
  req: Request,
  res: Response,
): Promise<void> {
  publicHeaders(res);

  res.json({
    success: true,
    message: "Embed",
    data: await embedPayload(req.params["token"] ?? ""),
  });
}

export async function readEmbedFileController(
  req: Request,
  res: Response,
): Promise<void> {
  publicHeaders(res);

  const path = req.query["path"];

  res.json({
    success: true,
    message: "File",
    data: await embedFile(
      req.params["token"] ?? "",
      typeof path === "string" ? path : "",
    ),
  });
}
