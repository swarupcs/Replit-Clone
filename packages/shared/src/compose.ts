/** What a project's own `docker-compose.yml` did, as the editor sees it.
 *
 *  plan.md §11.3. A very large share of real repositories are not "an app" —
 *  they are an app, a Postgres, a Redis and sometimes a worker. Until this
 *  existed such a repository opened here, showed its compose file with a
 *  Docker icon, and could not be run at all.
 *
 *  What runs is not Compose: it is the project's own container plus the
 *  services the file declares, as one lifecycle unit. A `build:` service is
 *  therefore named rather than started — the project's container already is
 *  that service — and only a deliberate subset of keys is honoured, with the
 *  rest reported on `unsupported` rather than dropped quietly.
 */

export interface ComposeRefusal {
  key: string;
  reason: string;
}

export interface ComposeServiceSummary {
  /** The key in the file, and the hostname the app reaches it at. */
  name: string;
  image: string;
  /** Ports the file mentioned. Nothing is published to the host — these are
   *  what the app connects to, at `<name>:<port>`. */
  ports: number[];
  /** Environment variable NAMES the file set. Values are deliberately not
   *  returned: they are in the repository already, but this endpoint exists to
   *  explain a file rather than to hand its contents back. */
  envNames: string[];
  /** running, stopped, absent — or refused, when this deployment will not
   *  start it and `refusal` says why. */
  status: "running" | "stopped" | "absent" | "refused";
  refusal: string | null;
}

export interface ComposeState {
  /** Null when the project has no compose file at all. */
  source: string | null;
  services: ComposeServiceSummary[];
  /** The service the file describes as the app itself, if it has one. Named so
   *  it does not look like a service that was silently dropped: the project's
   *  own container plays that part. */
  appService: string | null;
  unsupported: ComposeRefusal[];
  /** Set when a file was found and could not be read. The project's container
   *  still starts — being locked out of a project by the file you are trying
   *  to fix is the worst failure available here. */
  error: string | null;
  /** Whether this deployment runs compose services at all. When false the file
   *  is still read and reported, so the panel can say what WOULD happen. */
  enabled: boolean;
  /** Images this deployment permits, so a refusal can say what would have
   *  worked. */
  allowedImages: string[];
  /** How many services one project may start here. */
  maxServices: number;
}
