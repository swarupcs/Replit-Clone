/** Whether a project's dev server has to poll for file changes.
 *
 *  A project's files live on the host and are bind-mounted into its container.
 *  On a Linux host that mount carries inotify, so every dev server's watcher
 *  works the way it does outside Docker: save a file, the page updates.
 *
 *  Docker Desktop on Windows and macOS does not carry it. The container sees
 *  the new contents and the new mtime the instant they are written — but no
 *  event ever arrives, so Next, Vite and tsx alike sit there compiling nothing.
 *  The symptom is a save that plainly worked (the file on disk has it, the
 *  editor has it) and a preview that never changes, which reads as a broken
 *  save rather than a watcher that was never told.
 *
 *  Polling is the only cure, and it is not free — every watcher stats every
 *  watched file on an interval — so it is off where the filesystem does the job
 *  properly, which is the deployment target.
 */

/** How often a polling watcher looks, in milliseconds.
 *
 *  Watchpack's own default for `WATCHPACK_POLLING=true` is about five seconds,
 *  which is long enough that a save feels ignored. This trades a little idle
 *  CPU for a save that shows up while the user is still looking at it.
 */
export const POLL_INTERVAL_MS = 1000;

export interface WatchHost {
  /** WATCH_POLLING, when it was set. Settles it either way. */
  override?: boolean;
  /** Whether the SERVER is itself running in a container, which is how it is
   *  deployed — and means the bind mount comes from the Linux host it shares
   *  with the sandboxes. */
  inContainer: boolean;
  /** `process.platform`. */
  platform: string;
}

/** Decides whether the sandboxes should poll.
 *
 *  The question is really "does this host's bind mount deliver inotify", and
 *  nothing reports that, so it is inferred: a Linux host does, Docker Desktop's
 *  virtual machine boundary does not. A server running inside a container is
 *  deployed under docker compose beside the sandboxes, sharing one Linux
 *  kernel, whatever `process.platform` says about the image it was built from.
 */
export function shouldPollForChanges({
  override,
  inContainer,
  platform,
}: WatchHost): boolean {
  if (override !== undefined) return override;
  if (inContainer) return false;
  return platform !== "linux";
}

/** The variables that turn polling on, for the container `Env` of anything that
 *  starts a dev server.
 *
 *  Both families are named because the templates use both: Next goes through
 *  webpack's watchpack, while Vite and `tsx watch` go through chokidar. Empty
 *  when polling is off, so it can be spread unconditionally.
 */
export function pollingEnv(polling: boolean): string[] {
  if (!polling) return [];

  return [
    // Watchpack reads a number as the interval; `true` would mean its own
    // five-second default.
    `WATCHPACK_POLLING=${String(POLL_INTERVAL_MS)}`,
    "CHOKIDAR_USEPOLLING=true",
    `CHOKIDAR_INTERVAL=${String(POLL_INTERVAL_MS)}`,
  ];
}
