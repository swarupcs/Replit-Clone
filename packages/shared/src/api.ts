import type { TreeNodeData } from "./tree.js";

/** GET /ping and GET /api/v1/ping */
export interface PingResponse {
  message: string;
}

/** POST /api/v1/projects — `data` is the new project's id. */
export interface CreateProjectResponse {
  message: string;
  data: string;
}

/** GET /api/v1/projects/:projectId/tree */
export interface ProjectTreeResponse {
  success: boolean;
  message: string;
  data: TreeNodeData | null;
}
