/** What the platform tells one person, and how.
 *
 *  Both features that most needed this shipped without it, and they share a
 *  failure mode rather than a bug: a scheduled job's failure is silent by
 *  construction — nobody is watching a thing that exists precisely so nobody
 *  has to — and a moderation queue is a page somebody has to think to open.
 *  Each was honest to whoever looked, which is the person who already knew.
 *
 *  A notification is a stored RECORD first and mail second. That ordering is
 *  forced by this codebase rather than chosen: the mailer falls back to
 *  logging, so routing news straight to mail leaves an install without SMTP
 *  telling its users nothing at all.
 */

/** Why somebody is being told something.
 *
 *  Deliberately few, and every one of them a state CHANGE. There is no
 *  `JOB_FAILED`, because a job that fails every night is one piece of news and
 *  a message a night is how a feature meant to end silence teaches people to
 *  filter it — which re-creates the silence and hides that it has.
 */
export type NotificationKind =
  /** A job that had been working has started failing. */
  | "JOB_FAILING"
  /** ...and has started working again. News for the same reason. */
  | "JOB_RECOVERED"
  /** A moderator made this project private. */
  | "PROJECT_UNPUBLISHED"
  /** ...and lifted it again, which the same person has to hear. */
  | "PROJECT_REINSTATED"
  /** This account has crossed into the last fifth of one of its quotas. Sent
   *  on the CROSSING, once, and not again until it is no longer true — the
   *  same rule as everything above it. Falling back under the line is silent:
   *  nobody was harmed by a limit they never reached, and somebody who has
   *  just deleted a project does not need to be told it worked. */
  | "QUOTA_WARNING"
  /** An operator changed this account's plan or its limits. The same argument
   *  the takedown notification makes: a decision taken about somebody, by
   *  somebody else, is one they should hear from us rather than discover from
   *  a refusal — or from a number on a screen that changed overnight. */
  | "PLAN_CHANGED"
  /** A payment failed, or the subscription ended. Two moments, both of them
   *  actionable, and nothing in between: a renewal that works is not news, and
   *  a message every day of a grace period is how a channel somebody needs
   *  becomes one they filter. What each of these says is what changes and by
   *  when — never that anything has been taken away, because nothing is. */
  | "BILLING_PROBLEM";

export interface Notification {
  id: string;
  kind: NotificationKind;
  /** Written when it was created, never re-rendered on read: what a message
   *  said must not change because the thing it described changed later. */
  title: string;
  body: string;
  /** A path in the web app, query included, or null when there is nowhere
   *  useful to point. */
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationList {
  items: Notification[];
  /** Counted separately rather than derived from `items`, which is a page. A
   *  badge reading "3" beside a list of twenty is worse than no badge. */
  unread: number;
}

/** One page of the inbox. Small on purpose: this is a dropdown, and anybody
 *  who needs archaeology needs the thing itself, not its announcements. */
export const NOTIFICATIONS_PAGE = 30;

/** Kept per user. Beyond this the oldest are pruned, because an inbox nobody
 *  can reach the bottom of is a log, and a log is what this is not. */
export const NOTIFICATIONS_KEPT = 200;
