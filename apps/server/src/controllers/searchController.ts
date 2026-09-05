import type { Request, Response } from "express";
import { z } from "zod";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { searchAcrossProjects } from "../service/searchService.js";

/** The query, bounded before it reaches a regular-expression compiler.
 *
 *  `isRegex` means the user's text becomes a pattern, and this search runs it
 *  across every project they own rather than one — so the length cap matters
 *  more here than it does on the socket, where the same text costs one walk.
 *  Everything else is a flag with a safe default.
 */
const searchSchema = z.object({
  query: z.string().min(1).max(500),
  caseSensitive: z.coerce.boolean().optional(),
  wholeWord: z.coerce.boolean().optional(),
  isRegex: z.coerce.boolean().optional(),
});

/** Search across every project the account owns.
 *
 *  Scoped by the auth context and by nothing else: there is no id in the path
 *  and none in the query, which is the only scoping nobody can forget to
 *  apply — the same reason the account router is mounted that way.
 *
 *  A GET, because it is a read with no side effect and a user should be able
 *  to link to a search. The query is in the query string for the same reason,
 *  which is safe here in a way it would not be for anything personal: it is
 *  the user's own search text, going to the user's own server.
 */
export async function searchAllProjectsController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  const options = searchSchema.parse(req.query);

  res.json({ data: await searchAcrossProjects(userId, options) });
}
