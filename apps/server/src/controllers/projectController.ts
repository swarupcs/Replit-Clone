import type { Request, Response } from "express";
import {
  createProjectService,
  getProjectTreeService,
} from "../service/projectService.js";

export const createProjectController = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  const projectId = await createProjectService();

  res.json({ message: "Project created", data: projectId });
};

export const getProjectTree = async (
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> => {
  const tree = await getProjectTreeService(req.params.projectId);
  res.status(200).json({
    data: tree,
    success: true,
    message: "Successfully fetched the tree",
  });
};
