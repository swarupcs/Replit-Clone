import type { Request, Response } from "express";
import { z } from "zod";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertProjectAccess } from "../service/projectAccessService.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import { NotFoundError } from "../utils/errors.js";
import {
  createJob,
  deleteJob,
  listJobs,
  listRuns,
  runJobNow,
  updateJob,
} from "../service/scheduleService.js";
import { prisma } from "../lib/prisma.js";

/** Who may do what with a schedule.
 *
 *  Reading is a viewer's — a collaborator should be able to see whether last
 *  night's job ran without being handed the ability to change what runs.
 *  Writing is the owner's alone, and deliberately not an editor's: a scheduled
 *  job is code that executes in the owner's container, under the owner's
 *  environment variables, with nobody watching. "May edit a file" and "may
 *  arrange for a command to run at 3am forever" are not the same grant, and
 *  the second one is the shape of a backdoor if it is handed out with the
 *  first.
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

const jobId = z.string().uuid();

function readJobId(req: Request): string {
  const parsed = jobId.safeParse(req.params["jobId"] ?? "");
  // A malformed id is a job that does not exist, and saying so is one fewer
  // way to learn which ids are real.
  if (!parsed.success) throw new NotFoundError("No such job.", "JOB_NOT_FOUND");
  return parsed.data;
}

const createSchema = z.object({
  name: z.string().min(1).max(80),
  schedule: z.string().min(1).max(120),
  command: z.string().min(1).max(2000),
  enabled: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

export async function listJobsController(req: Request, res: Response): Promise<void> {
  const projectId = await authorise(req, "viewer");

  res.json({
    success: true,
    message: "Scheduled jobs",
    data: { jobs: await listJobs(projectId) },
  });
}

export async function createJobController(req: Request, res: Response): Promise<void> {
  const projectId = await authorise(req, "owner");
  const input = createSchema.parse(req.body);

  res.status(201).json({
    success: true,
    message: "Job scheduled",
    data: await createJob(projectId, input),
  });
}

export async function updateJobController(req: Request, res: Response): Promise<void> {
  const projectId = await authorise(req, "owner");
  const input = updateSchema.parse(req.body);

  res.json({
    success: true,
    message: "Job updated",
    data: await updateJob(projectId, readJobId(req), input),
  });
}

export async function deleteJobController(req: Request, res: Response): Promise<void> {
  const projectId = await authorise(req, "owner");
  await deleteJob(projectId, readJobId(req));

  res.json({ success: true, message: "Job deleted", data: null });
}

export async function listRunsController(req: Request, res: Response): Promise<void> {
  const projectId = await authorise(req, "viewer");

  res.json({
    success: true,
    message: "Runs",
    data: { runs: await listRuns(projectId, readJobId(req)) },
  });
}

export async function runJobController(req: Request, res: Response): Promise<void> {
  const projectId = await authorise(req, "owner");
  const id = readJobId(req);

  // `runJobNow` takes a job id and nothing else, because the sweeper has no
  // project to check it against. That makes confirming the job belongs to this
  // project this controller's job — without it, an owner of any project could
  // run any job on the machine by guessing its id.
  const owned = await prisma.scheduledJob.findFirst({
    where: { id, projectId },
    select: { id: true },
  });
  if (!owned) throw new NotFoundError("No such job.", "JOB_NOT_FOUND");

  res.json({
    success: true,
    message: "Job run",
    data: await runJobNow(id),
  });
}
