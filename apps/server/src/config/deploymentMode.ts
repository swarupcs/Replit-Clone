import { singleUserEnabled } from "../service/singleUserService.js";

/** What has a second person on the other end of it, and what does not.
 *
 *  §10.5 asked for this as ONE row, because it is one decision taken a dozen
 *  times, and leaving it implicit is how a personal deployment ends up shipping
 *  a report queue. So the decision is made once, here, and everything else
 *  reads it.
 *
 *  The important thing about the list below is that none of it is a preference.
 *  Each entry is dead by ARITHMETIC in single-user mode, not by taste:
 *
 *  - A share link is redeemed by signing in and becoming a collaborator. There
 *    is one account and it already owns the project.
 *  - A report is filed by somebody and reviewed by an operator, and §6 decision
 *    11 is that those are different people. Here they would be the same one.
 *  - The operator console administers accounts. There is one, and it is yours.
 *  - The gallery lists what OTHER people have published. At n=1 it can only
 *    ever contain your own projects, which the dashboard already shows.
 *
 *  Which is why this is derived from `SINGLE_USER_EMAIL` rather than being a
 *  second flag: a flag would imply these could sensibly be on, and they cannot.
 *
 *  **What is deliberately NOT here**, because each has a real user at n=1:
 *
 *  - **Embeds.** Putting your own project in your own blog post is a thing one
 *    person does alone. The audience is not an account here and never was.
 *  - **Deploy and custom domains.** Publishing is why a lot of personal
 *    projects exist.
 *  - **API keys.** §10.5's original list had these as dead, and that was
 *    wrong: a personal deployment with a build server is an ordinary setup,
 *    and §6 decision 17 already makes the key surface default-deny and tiny.
 *    Recorded as a deviation rather than followed silently.
 *  - **Collaborative editing (`collabService`).** Dead in the sense that
 *    nobody else will ever join, and NOT removed, because the server owns
 *    writing a file while its document is live and the editor suppresses its
 *    own writes for those paths. Turning it off would not simplify anything;
 *    it would stop saving.
 *  - **Scheduled jobs, notifications, the assistant, the database panel,
 *    GitHub, checkpoints, trash.** All single-player already.
 */
export interface DeploymentCapabilities {
  /** Share links and named collaborators. */
  sharing: boolean;
  /** Reporting a project, and the operator queue that reviews reports. */
  moderation: boolean;
  /** The operator console: accounts, machine status, moderation history. */
  operatorConsole: boolean;
  /** The public gallery and the Explore section that reads it. */
  gallery: boolean;
  /** A plan catalogue with more than one thing in it, and anything to buy. */
  plans: boolean;
}

/** What this deployment offers. */
export function capabilities(): DeploymentCapabilities {
  const shared = !singleUserEnabled();

  return {
    sharing: shared,
    moderation: shared,
    operatorConsole: shared,
    gallery: shared,
    plans: shared,
  };
}
