/** The record of what moderation did, and the owner's reply to it.
 *
 *  Unpublishing somebody's project is the one power here exercised *against* a
 *  user rather than for them, and until this existed it was also the only one
 *  with no trail: the queue recorded the report and its status, never who
 *  acted, when, or why. A moderator could not demonstrate they were fair and
 *  could not be shown to have been unfair.
 */

export type ModerationActionType =
  /** A moderator made the project private and took it down. */
  | "ACTIONED"
  /** A moderator looked and found nothing wrong. */
  | "DISMISSED"
  /** The owner asked for a takedown to be looked at again. */
  | "APPEALED"
  /** A moderator lifted a takedown. */
  | "REINSTATED";

export interface ModerationAction {
  id: string;
  projectId: string | null;
  /** Copied when the action was recorded, so the trail still names the project
   *  after it is deleted. */
  projectName: string;
  reportId: string | null;
  action: ModerationActionType;
  /** An operator's address for a decision, the owner's for an appeal. */
  actor: string;
  reason: string | null;
  createdAt: string;
}

/** How much an owner may write when appealing. Long enough to explain a
 *  misunderstanding, short enough not to be a channel of its own. */
export const MAX_APPEAL = 2000;

/** How much an operator may write when reinstating. */
export const MAX_MODERATION_REASON = 2000;
