import type { Entitlements, Plan, PlanId } from "./billing.js";

/** The operator's console.
 *
 *  Everything here grows what an operator can do, which §6 decision 11 says
 *  must not happen until something reviews it. So the audit trail is not a
 *  follow-up: every action below is recorded, with a required reason, in the
 *  same transaction as the change, and the person it was done to is told.
 *
 *  What is deliberately NOT here is worth stating, because it is the obvious
 *  next thing to add: **suspension**. An operator who can lock somebody out of
 *  their own work holds a much larger power than one who can make a project
 *  private, and decision 11's whole argument is that the authority stays the
 *  smallest one that resolves a complaint. Moderation acts on projects. If an
 *  account needs to be stopped, that is a decision for whoever owns the
 *  deployment, taken deliberately, and not a button on a console.
 */

export type AccountActionType =
  /** An operator moved this account to a different plan. */
  | "PLAN_CHANGED"
  /** An operator set limits for this account by hand, over its plan's. */
  | "OVERRIDE_SET"
  /** ...and took them away again, leaving the plan's. */
  | "OVERRIDE_CLEARED";

export interface AccountAction {
  id: string;
  /** Null once the account is deleted; `subjectEmail` still names it. */
  subjectUserId: string | null;
  subjectEmail: string;
  action: AccountActionType;
  actor: string;
  /** Never null. Required by the API for every action here. */
  reason: string;
  /** What changed, in words — "free to pro". A sentence to read, not a diff
   *  to replay. */
  detail: string | null;
  createdAt: string;
}

/** One row of the account search: enough to recognise somebody, and not their
 *  disk usage, which costs a walk of every tree they own. */
export interface AccountRow {
  userId: string;
  email: string;
  createdAt: string;
  planId: PlanId;
  planLabel: string;
  projects: number;
  overridden: boolean;
}

/** One account, opened. The summary the person themself sees, plus the trail
 *  of what has been done to them, which they cannot see and an operator must. */
export interface AccountDetail {
  userId: string;
  email: string;
  createdAt: string;
  entitlements: Entitlements;
  projects: number;
  diskBytes: number;
  actions: AccountAction[];
  /** The catalogue, so the console offers the plans that exist rather than the
   *  two somebody happened to write into a dropdown. */
  plans: Plan[];
}

/** Is this machine full?
 *
 *  The question a three-container cap makes an operator ask most often, and
 *  the one no screen could answer: `/metrics` is the only endpoint in the
 *  product with no client, which is defensible for a scrape target and leaves
 *  the counters visible only to somebody who curls the port.
 */
export interface MachineStatus {
  containersRunning: number;
  containerLimit: number;
  /** Scheduled runs sitting in `RUNNING`. A number that only goes up is the
   *  signature of §3.1's restart wedge, which is otherwise silent. */
  runningJobRuns: number;
  uptimeSeconds: number;
  memoryBytes: number;
  counters: Record<string, number>;
}

/** How much an operator must write when changing somebody's account. */
export const MAX_ACCOUNT_REASON = 2000;

/** How many accounts a search returns. Small: this is a lookup, not a report,
 *  and an operator who needs every account needs the database. */
export const ACCOUNT_SEARCH_LIMIT = 25;
