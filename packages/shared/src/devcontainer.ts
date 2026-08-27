/** What a project's `.devcontainer/devcontainer.json` did, as the editor sees it.
 *
 *  Every project otherwise runs the image its template chose, which is the most
 *  common reason a real repository will not run here: a project needing ffmpeg,
 *  libvips, a Postgres client or a different Node version has no way to say so.
 *  The devcontainer spec is the standard answer, and a repository that already
 *  carries one works here without being modified for here.
 *
 *  Only a subset is honoured. What was refused comes back on `unsupported`
 *  rather than being dropped quietly — a config that is half-applied is worse
 *  than one that is rejected, because the user cannot tell which half ran.
 */

export interface DevcontainerRefusal {
  key: string;
  reason: string;
}

export interface DevcontainerSummary {
  /** Which file it came from, e.g. ".devcontainer/devcontainer.json". */
  source: string;
  /** The image the config asked for, which is not necessarily the one running —
   *  compare against `imageInUse`. */
  requestedImage: string | null;
  forwardPorts: number[];
  containerEnvNames: string[];
  postCreateCommand: string[];
  postStartCommand: string[];
  workspaceFolder: string | null;
  unsupported: DevcontainerRefusal[];
}

export interface DevcontainerState {
  /** Null when the project has no devcontainer file at all. */
  config: DevcontainerSummary | null;
  /** The image the container is actually running, whatever the config asked
   *  for. Null before a container has ever been started. */
  imageInUse: string | null;
  /** Set when a config was found and could not be honoured — malformed JSON, an
   *  image the server does not permit. The container still starts on the
   *  template's defaults: being locked out of a project by the very file you
   *  are trying to fix is the worst failure available here. */
  error: string | null;
  /** Combined output of the lifecycle commands from the last start. */
  lifecycleLog: string;
  /** True while those commands are still running. */
  running: boolean;
  /** Images this server permits a devcontainer to ask for, so a refusal can say
   *  what would have worked. */
  allowedImages: string[];
}
