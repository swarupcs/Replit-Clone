import type { Page } from "./pagination.js";
/** Projects, forks, and the idea of a public one.
 *
 *  Duplicating a project you already have and forking a stranger's are the
 *  same copy with different permission around it, and the difference is the
 *  interesting part: a duplicate carries the environment variables because it
 *  is yours already, and a fork must not, because it is not.
 */

export type ProjectVisibility = "private" | "public";

/** A public project as the gallery sees it.
 *
 *  Deliberately narrow. The full project row carries `envVars` and
 *  `shareToken`, and this list is readable by anybody with an account.
 */
export interface PublicProject {
  id: string;
  name: string;
  /** Template id, so the gallery can show what it was started from. */
  template: string;
  /** ISO 8601. */
  createdAt: string;
  /** The local part of the owner's address, never the whole of it. */
  ownerName: string;
  /** How many copies people have taken. */
  forks: number;
}

/** Why somebody reported a published project.
 *
 *  `SECRETS` first because it is the one where speed matters and where the
 *  owner is usually grateful rather than aggrieved -- a key in a committed
 *  `.env` is a mistake, not an offence.
 */
export type ReportReason =
  | "SECRETS"
  | "ABUSE"
  | "MALWARE"
  | "INFRINGEMENT"
  | "OTHER";

export type ReportStatus = "OPEN" | "DISMISSED" | "ACTIONED";

export interface ProjectReport {
  id: string;
  projectId: string;
  projectName: string;
  ownerEmail: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  /** Null once the account that filed it has been deleted. The report
   *  outlives the reporter, and stops naming them. */
  reporterEmail: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export interface ReportsResponse {
  success: true;
  message: string;
  data: Page<ProjectReport>;
}

export interface ReviewReportResponse {
  success: true;
  message: string;
  data: { report: ProjectReport };
}
