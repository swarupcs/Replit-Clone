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
  | "ai_errors";

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
