import type { PlanId } from "./billing.js";

/** What a subscription is doing, as the processor last described it.
 *
 *  Four states and not Stripe's dozen, because the only question this codebase
 *  asks of a subscription is whether the account is entitled to its plan right
 *  now. Everything Stripe distinguishes beyond that — incomplete, unpaid,
 *  paused, incomplete_expired — collapses into one of these on the way in, in
 *  one function, so a status this product has never heard of cannot reach a
 *  screen.
 */
export type SubscriptionStatus =
  /** Paid and current. */
  | "ACTIVE"
  /** Free period before the first charge. Entitled, exactly like ACTIVE. */
  | "TRIALING"
  /** A payment failed, and the grace period has not run out. Still entitled:
   *  a card that expired on a Friday must not take somebody's work away on
   *  the Saturday. */
  | "PAST_DUE"
  /** Ended — by the customer, or by the processor giving up. Not entitled. */
  | "CANCELED";

/** The subscription as the account screen reads it.
 *
 *  Deliberately not the row: no processor ids, no internal keys. What a person
 *  needs is what they are paying for, whether anything is wrong, and by when.
 */
export interface SubscriptionState {
  status: SubscriptionStatus;
  /** The plan the subscription is FOR, which is not always the plan the
   *  account is ON — a past-due subscription past its grace is for `pro` while
   *  the account has dropped to `free`. Showing both is what makes the screen
   *  able to say "you were on Pro, fix your card and you are back on it". */
  planId: PlanId;
  planLabel: string;
  /** When the paid period ends. A cancellation counts down to this rather than
   *  taking effect at once: cancelling does not take away what was paid for. */
  currentPeriodEnd: string | null;
  /** When a failing payment stops being tolerated. Null unless PAST_DUE. */
  graceUntil: string | null;
  /** Whether the account is currently getting the plan it pays for. False for
   *  a cancelled subscription, and for a past-due one whose grace has run
   *  out. */
  entitled: boolean;
}

/** How long a failed payment is tolerated before the account drops to free.
 *
 *  Long enough for a person to notice an email and find a different card;
 *  short enough that it is not a free month. Nothing is deleted at the end of
 *  it — see the note on downgrades in plan.md §8.4 — the account simply stops
 *  being able to grow.
 */
export const BILLING_GRACE_DAYS = 7;
