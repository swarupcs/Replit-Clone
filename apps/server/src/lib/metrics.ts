/** Counters and gauges for the things that go wrong in production.
 *
 *  Deliberately in-process and dependency-free: this is a single-node tool, and
 *  a Prometheus client would be more machinery than the question deserves. The
 *  numbers are exposed as JSON on /health, which is enough to answer "is it the
 *  containers, the runs, or the proxy?" without shipping logs anywhere.
 */

export type CounterName =
  | "containers_started"
  | "containers_reaped"
  | "containers_capacity_rejected"
  | "runs_started"
  // Starts that found the dependencies already installed and left the
  // install half of the command out. Against `runs_started`, this is how much
  // of the warm-start path is actually being taken.
  | "runs_install_skipped"
  | "runs_failed"
  | "preview_errors"
  | "preview_upgrades_rejected"
  | "terminal_sessions"
  | "quota_rejections"
  | "search_timeouts"
  | "auth_failures"
  | "ai_requests"
  | "ai_tool_calls"
  | "ai_proposals"
  | "ai_errors"
  // Deployments. `deploys_failed` against `deploys_succeeded` is the ratio
  // worth watching: a build that fails is a user who published nothing.
  | "deploys_succeeded"
  | "deploys_failed"
  | "deploys_removed"
  // Always-on deployments: one container per published service.
  | "deploy_services_started"
  | "deploy_services_capacity_rejected"
  | "deploy_service_proxy_errors"
  | "deploy_service_unavailable"
  // A request to the public origin whose path tried to leave one site's
  // directory. Never zero-and-forgotten: this counting up at all says
  // somebody is probing the one origin that needs no account.
  | "deploy_site_traversal_blocked"
  // Embeds. `embed_views` is how much reach the feature actually has;
  // `embed_path_rejected` is the other kind of number entirely -- an
  // unauthenticated endpoint being asked for paths it does not serve.
  | "embeds_created"
  | "embeds_revoked"
  | "embed_views"
  | "embed_path_rejected"
  // Moderation. `project_reported` climbing while `report_actioned` and
  // `report_dismissed` stay flat is the signal that matters most here: it says
  // the queue is filling and nobody is reading it, which is the failure mode a
  // report mechanism with no reviewer actually has.
  | "project_reported"
  | "report_actioned"
  | "report_dismissed"
  // Custom domains. `domain_unverified` climbing is the interesting one: it
  // counts names that were verified and are not any more, which is either
  // somebody's DNS breaking or a domain changing hands.
  | "domain_verified"
  | "domain_unverified"
  // Scheduled jobs. `jobs_skipped` is the one that says a schedule is wrong
  // rather than a command: it counts firings that found the previous run still
  // going, which is a job asked to run more often than it takes to run.
  | "jobs_created"
  | "jobs_started"
  | "jobs_succeeded"
  | "jobs_failed"
  | "jobs_skipped";

const counters = new Map<CounterName, number>();

export function increment(name: CounterName, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

/** Point-in-time values, supplied by whoever owns the underlying state. */
const gauges = new Map<string, () => number>();

export function registerGauge(name: string, read: () => number): void {
  gauges.set(name, read);
}

export function snapshot(): Record<string, number> {
  const result: Record<string, number> = {};

  for (const [name, value] of counters) result[name] = value;

  for (const [name, read] of gauges) {
    try {
      result[name] = read();
    } catch {
      // A gauge that cannot be read must not take the health endpoint with it.
      result[name] = -1;
    }
  }

  return result;
}

/** Only for tests, which need a clean slate between cases. */
export function resetMetrics(): void {
  counters.clear();
}
