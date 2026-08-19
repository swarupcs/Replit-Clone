import type { TreeNodeData } from "./tree.js";

/** Every REST response uses this envelope. */
export interface ApiSuccess<T> {
  success: true;
  message: string;
  data: T;
}

export interface ApiFailure {
  success: false;
  code: string;
  message: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface Project {
  id: string;
  name: string;
  template: string;
  ownerId: string;
  createdAt: string;
  lastActiveAt: string | null;
}

/** GET /ping */
export interface PingResponse {
  message: string;
}

/** POST /api/v1/projects */
export type CreateProjectResponse = ApiSuccess<Project>;

/** GET /api/v1/projects */
export type ListProjectsResponse = ApiSuccess<Project[]>;

/** GET /api/v1/projects/:projectId/tree */
export type ProjectTreeResponse = ApiSuccess<TreeNodeData | null>;

/** A project template offered at creation time. */
export interface TemplateSummary {
  id: string;
  label: string;
  /** Port the dev server listens on inside the container. */
  devPort: number;
  /** Shown in the UI so the user knows what to run. */
  startCommand: string;
}

/** GET /api/v1/projects/templates */
export type ListTemplatesResponse = ApiSuccess<TemplateSummary[]>;
