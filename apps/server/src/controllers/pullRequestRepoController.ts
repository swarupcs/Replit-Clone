import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { BadRequestError } from "../utils/errors.js";

/** Enrolling a repository for pull request workspaces. plan.md §13.3.
 *
 *  Enrolment is what answers "whose account pays for this", and §13.3's model
 *  comment says why it is explicit rather than inferred from a connected
 *  account's login.
 */

/** GitHub's own naming rules, applied before the value becomes a database key
 *  that a webhook will later be matched against. */
const NAME = /^[A-Za-z0-9._-]+$/;

export const enrolSchema = z.object({
  owner: z.string().min(1).max(100).regex(NAME),
  repo: z.string().min(1).max(100).regex(NAME),
});

export async function listPullRequestReposController(req: Request, res: Response) {
  const { userId } = getAuthContext(req);
  const rows = await prisma.pullRequestRepo.findMany({
    where: { userId },
    select: { id: true, owner: true, repo: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  res.json({ success: true, message: "Enrolled repositories", data: rows });
}

export async function enrolPullRequestRepoController(req: Request, res: Response) {
  const { userId } = getAuthContext(req);
  const parsed = enrolSchema.parse(req.body);

  // Lower-cased here and nowhere else afterwards: GitHub sends whichever case
  // the event carried, so the key has to be written in the same shape it will
  // be looked up in.
  const owner = parsed.owner.toLowerCase();
  const repo = parsed.repo.toLowerCase();

  const existing = await prisma.pullRequestRepo.findUnique({
    where: { owner_repo: { owner, repo } },
    select: { userId: true },
  });

  if (existing && existing.userId !== userId) {
    // One enrolment per repository, and the reason is the whole point of the
    // row: two accounts both claiming it would make "whose quota" a question
    // with two answers.
    throw new BadRequestError(
      "Another account has already enrolled that repository.",
      "REPO_ENROLLED_ELSEWHERE",
    );
  }

  const row = await prisma.pullRequestRepo.upsert({
    where: { owner_repo: { owner, repo } },
    create: { owner, repo, userId },
    update: {},
    select: { id: true, owner: true, repo: true, createdAt: true },
  });

  res.status(201).json({ success: true, message: "Enrolled", data: row });
}

export async function removePullRequestRepoController(req: Request, res: Response) {
  const { userId } = getAuthContext(req);
  const parsed = enrolSchema.parse(req.params);

  // `deleteMany` with the userId in the WHERE rather than a find-then-delete:
  // one statement, and somebody else's enrolment cannot be removed by guessing
  // its name.
  const { count } = await prisma.pullRequestRepo.deleteMany({
    where: { owner: parsed.owner.toLowerCase(), repo: parsed.repo.toLowerCase(), userId },
  });

  res.json({ success: true, message: count > 0 ? "Removed" : "Nothing to remove", data: null });
}
