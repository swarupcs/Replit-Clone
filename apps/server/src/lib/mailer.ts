import { env, isProduction } from "../config/env.js";
import { logger } from "./logger.js";

/** Sending mail.
 *
 *  Deliberately an interface with a logging default rather than a bundled
 *  provider. A self-hosted deployment may have SMTP, an API key for a hosted
 *  service, or nothing at all, and hard-wiring one would be wrong for the other
 *  two. Without configuration the message is logged, so password reset works in
 *  development by reading the server output.
 */

export interface Mail {
  to: string;
  subject: string;
  /** Plain text. HTML mail is a rabbit hole and these are two-line messages. */
  text: string;
}

export interface Mailer {
  send: (mail: Mail) => Promise<void>;
}

/** Writes the message to the log instead of sending it.
 *
 *  In development that is genuinely useful — the reset link is right there in
 *  the terminal. In production it is a misconfiguration, and says so loudly,
 *  because a silently unsent password reset looks to the user like the account
 *  no longer exists.
 */
const loggingMailer: Mailer = {
  send: (mail) => {
    if (isProduction) {
      logger.error(
        "no mailer configured; this message was NOT delivered",
        undefined,
        { to: mail.to, subject: mail.subject },
      );
    } else {
      logger.info(`[mail] to=${mail.to} subject=${mail.subject}\n${mail.text}`);
    }

    return Promise.resolve();
  },
};

let mailer: Mailer = loggingMailer;

/** Installs a real mailer. Called from the composition root when one is
 *  configured; left alone otherwise. */
export function setMailer(next: Mailer): void {
  mailer = next;
}

export function getMailer(): Mailer {
  return mailer;
}

/** True when mail actually goes somewhere. The API uses this to tell the user
 *  whether to expect an email or to look in the server log. */
export function hasRealMailer(): boolean {
  return mailer !== loggingMailer;
}

/** Builds a link into the web app. */
export function webUrl(path: string, params: Record<string, string>): string {
  const url = new URL(path, env.WEB_ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
