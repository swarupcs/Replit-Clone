import type { SubscriptionState } from "./subscriptions.js";
/** What an account is allowed to do, and where the numbers come from.
 *
 *  Every limit in this product used to be a constant in `env`, which is the
 *  right shape for a deployment and the wrong one for a product: a SaaS
 *  product is precisely one where these numbers differ per customer. So they
 *  moved to a `Plan` row, and `env` became the free plan's defaults rather
 *  than the whole story.
 *
 *  Only the limits that are *about an account* live here. `MAX_CONCURRENT_-
 *  CONTAINERS`, `CONTAINER_MEMORY_MB` and `DEPLOY_MEMORY_MB` deliberately do
 *  not: those are about the machine, and a plan that promises more memory per
 *  container than the host has is a promise kept by an OOM kill in somebody's
 *  terminal rather than by an honest refusal. See plan.md §6 decision 15.
 */

/** Stable plan identifiers. Strings rather than an enum because they are also
 *  the primary key of the catalogue table, and adding a tier should be a row
 *  rather than a migration of every account that references one. */
export type PlanId = string;

/** The free plan's id, which is also the fallback when anything at all goes
 *  wrong resolving an account's entitlements. It is a constant because two
 *  places have to agree on it and neither may be the other's source. */
export const FREE_PLAN_ID = "free";

/** The plan for a deployment with one person on it.
 *
 *  Seeded alongside `free`, and what single-user mode puts its account on.
 *  Every allocation on it is `UNLIMITED`, for the reason §10.4 gives: the
 *  per-account numbers ration a shared VM between tenants, and at n=1 there is
 *  nobody to ration against. A 512 MB project quota on somebody's own machine
 *  is an editor refusing to save into their own free space.
 *
 *  What it does NOT raise is anything about the host — `CONTAINER_MEMORY_MB`,
 *  `MAX_CONCURRENT_CONTAINERS`, `DEPLOY_MEMORY_MB` — because §6 decision 15 is
 *  about what a plan may promise, and it may promise more of what this platform
 *  allocates and never more than the machine has. That argument does not weaken
 *  at one user; it is the same OOM kill in the same terminal. */
export const PERSONAL_PLAN_ID = "personal";

/** A limit of zero means there is no limit.
 *
 *  Zero rather than a very large number, and rather than `null`: the columns
 *  are non-null integers and every consumer compares them arithmetically, so a
 *  sentinel that is already a valid integer keeps the schema, the override
 *  parser and the API shape exactly as they are. It also reads correctly in the
 *  place that already had this rule before it was written down —
 *  `isNearQuota` has always guarded on `limit > 0`, because dividing by a limit
 *  of zero is how a meter that means nothing gets drawn.
 *
 *  The one cost is that "zero projects allowed" is now unsayable. Nothing wants
 *  to say it: a plan that permits nothing is an account that cannot be used,
 *  which is suspension, and §6 decision 18 puts that firmly outside what an
 *  operator may do here. */
export const UNLIMITED = 0;

/** Whether a limit is one at all.
 *
 *  Exported and used at each of the five places that enforce a limit rather
 *  than folded into one helper that does the comparison too, because those
 *  five do not compare the same way — a project COUNT reaching its limit is
 *  refused (`>=`), and a byte total is refused only past it (`>`). A helper
 *  that hid that difference would make one of the five silently off by one. */
export function isUnlimited(limit: number): boolean {
  return limit <= UNLIMITED;
}

/** The limits themselves, separated from the plan they came from so that an
 *  override can be expressed as a partial of exactly this shape. */
export interface EntitlementLimits {
  /** How many projects this account may own. */
  maxProjects: number;
  /** Total disk across all of them. */
  userDiskQuotaMb: number;
  /** Ceiling on any single one. */
  projectDiskQuotaMb: number;
  /** Assistant requests per hour. */
  aiRequestsPerHour: number;
  /** How many of this account's projects may be running at once. Bounded in
   *  turn by the machine's own cap, which no plan can raise. */
  maxContainersPerUser: number;

  /** Features, as opposed to amounts. Each is already a working capability
   *  behind a deployment-wide flag; a plan decides who gets it. */
  managedDatabases: boolean;
  customDomains: boolean;
  scheduledJobs: boolean;
}

/** A tier as offered, which is the limits plus what it is called and costs. */
export interface Plan extends EntitlementLimits {
  id: PlanId;
  label: string;
  /** Minor units — cents — because a price is not a float. Zero is free. */
  priceCents: number;
  currency: string;
  /** Display order, and the only thing that makes "upgrade" meaningful. */
  rank: number;
}

/** What an account actually gets: its plan's limits with any override applied,
 *  plus enough about where each came from to render it honestly.
 *
 *  `planId` is the plan of record even when every number has been overridden —
 *  an account comped up to Pro limits is still on the plan it pays for, and
 *  conflating the two is how a billing system starts lying about revenue. */
export interface Entitlements extends EntitlementLimits {
  planId: PlanId;
  planLabel: string;
  /** True when an operator has adjusted at least one number by hand. Shown to
   *  the account holder, because a limit they cannot find on any pricing page
   *  should say why it is different rather than look like a bug. */
  overridden: boolean;
  /** When the override lapses, if it does. A trial that must be remembered to
   *  be ended is a trial that never ends. */
  overrideUntil: string | null;
}

/** One project's share of the account's disk. The half that makes a quota
 *  actionable: "you are out of space" is not something anybody can act on, and
 *  "this project is 4 GB of the 5 you have" is. */
export interface ProjectUsage {
  projectId: string;
  name: string;
  diskBytes: number;
}

/** Everything the account screen needs, in one response.
 *
 *  One endpoint rather than three, because the three are only meaningful
 *  together: a number, its limit, and what is responsible for it. */
export interface AccountSummary {
  email: string;
  entitlements: Entitlements;
  /** Projects owned. Shared projects count against whoever owns them. */
  projects: number;
  diskBytes: number;
  /** Owned projects, largest first. */
  breakdown: ProjectUsage[];
  /** The catalogue, so the screen can say what else exists without a second
   *  request. Archived plans are omitted; an account *on* an archived plan
   *  still reads its own limits from `entitlements`. */
  plans: Plan[];
  /** Container-seconds this calendar month, across every project this account
   *  owns — sandboxes and published services both.
   *
   *  Shown and not charged for. plan.md §8.8 asks whether this product sells
   *  capability or sells minutes and says the code is shaped for the first;
   *  that question cannot be answered without a number, so the number exists
   *  first and the decision waits for it. Until then this is a fact somebody
   *  may find interesting, and nothing refuses anything on it. */
  computeSecondsThisMonth: number;
  /** What this account is paying for, or null for one that never has.
   *
   *  Null is the ordinary state of every account on a deployment with no
   *  processor configured, which is why the screen has to read it as "the free
   *  plan" rather than as something being wrong. */
  subscription: SubscriptionState | null;
}

/** The fraction of a quota at which somebody should be told, before the wall
 *  rather than at it. Crossing it is a change of state and notifies once —
 *  being over it is a state and says nothing further (§6 decision 14). */
export const QUOTA_WARN_FRACTION = 0.8;
