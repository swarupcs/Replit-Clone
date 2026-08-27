import path from "node:path";
import { existsSync } from "node:fs";
import dotenv from "dotenv";
import { z } from "zod";
import {
  pollingEnv,
  shouldPollForChanges,
} from "./fileWatching.js";

// Not under test. `setupEnv.ts` puts a complete, deliberate environment in
// place before this module loads, and dotenv fills only what is UNSET -- so a
// developer's own `.env` used to leak straight into the suite. Setting
// AUTO_START_ON_OPEN=false, which the example file recommends for a small VM,
// failed six auto-start tests on their machine and nowhere else.
if (process.env["NODE_ENV"] !== "test") dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be >= 32 chars"),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, "JWT_REFRESH_SECRET must be >= 32 chars"),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** The preview cookie is sent to a container running untrusted project code,
   *  so it is short-lived. Every session refresh reissues it, which happens
   *  well inside this window for anyone actually using the editor. */
  PREVIEW_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(12),

  /** Port serving project previews, on an origin of its own.
   *
   *  Previews must NOT share the API's origin: a project's code would then run
   *  same-origin with the API and could mint itself a session from the refresh
   *  cookie. Serving them from their own origin is what lets the editor grant
   *  the preview iframe `allow-same-origin` — without which the frame has an
   *  opaque origin and every module script in it fails CORS, which is a white
   *  pane rather than a running app.
   *
   *  Defaults to the API's port plus one. Set to 0 to serve previews from the
   *  API's own origin instead, accepting the trade above; the editor then
   *  withholds `allow-same-origin` and only server-rendered previews work. */
  PREVIEW_PORT: z.coerce.number().int().min(0).optional(),

  /** Port serving published deployments, on a third origin of its own.
   *
   *  It cannot share the API's origin for the reason previews cannot, and it
   *  cannot share the PREVIEW origin either: a preview is authenticated and a
   *  deployment is public, so anything served here would be same-origin with a
   *  page that carries a live preview cookie. Three concerns, three origins.
   *
   *  Defaults to the API's port plus two. Set to 0 to turn deployments off
   *  entirely -- the endpoints then refuse rather than publishing to a listener
   *  that is not running. */
  DEPLOY_PORT: z.coerce.number().int().min(0).optional(),

  /** The public origin deployments are addressed under, WITHOUT a subdomain.
   *
   *  A site is served at `<subdomain>.<this host>`, so this host needs a
   *  wildcard DNS record and, over HTTPS, a wildcard certificate. Locally that
   *  is free: browsers resolve every *.localhost name to the loopback address
   *  themselves, per RFC 6761, so http://<sub>.localhost:3102 works with no
   *  hosts-file entry.
   *
   *  Defaults to localhost on DEPLOY_PORT. */
  DEPLOY_ORIGIN: z.string().url().optional(),

  /** Where published output is copied to. Outside PROJECTS_DIR deliberately:
   *  what is served to the public must not be reachable from a path a project's
   *  own code can write to. */
  DEPLOYMENTS_DIR: z.string().default("deployments"),

  /** Ceiling on one published site.
   *
   *  A deployment outlives its container, so unlike the project quota this is
   *  disk nothing reclaims on its own. A build that exceeds it is refused
   *  before anything is copied. */
  DEPLOY_MAX_MB: z.coerce.number().int().positive().default(100),

  /** Longest a deploy build may run before it is abandoned.
   *
   *  A build is an unattended `npm install` plus a bundler, which is minutes
   *  rather than seconds -- but it holds a container and a request, so it
   *  cannot be unbounded. */
  DEPLOY_BUILD_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(10),

  WEB_ORIGIN: z.string().url().default("http://localhost:5273"),

  /** This server's own public origin. Needed because an OAuth redirect_uri has
   *  to be absolute and has to match what is registered with the provider. */
  API_ORIGIN: z.string().url().default("http://localhost:3000"),

  /** GitHub sign-in. Both empty means the feature is simply off. */
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),

  /** 32 bytes, base64, for secrets the server has to keep and later spend --
   *  today the GitHub token that makes importing and pushing possible without
   *  retyping one.
   *
   *  Optional, and its absence turns those features off rather than taking the
   *  process down: a deployment that does not use them should not have to
   *  invent a key. Generate one with `openssl rand -base64 32`. */
  SECRET_ENCRYPTION_KEY: z.string().optional(),

  /** The AI assistant. No key means the feature is simply off, exactly like
   *  GitHub sign-in above: the panel is not offered rather than being offered
   *  and then failing. */
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("claude-sonnet-5"),
  AI_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  /** Per user, per hour.
   *
   *  Unlike every other limit here this one guards a bill rather than the VM,
   *  and it is deliberately per USER: a shared deployment where one person can
   *  spend the whole budget is not a shared deployment. */
  AI_REQUESTS_PER_HOUR: z.coerce.number().int().positive().default(60),

  /** How many reverse proxies sit in front of this server.
   *
   *  Express needs this to work out which entry in X-Forwarded-For is the real
   *  client. Left at 0 every request behind Traefik or nginx reports the
   *  proxy's own address, so per-IP rate limits apply to the whole deployment
   *  at once: one person mistyping their password locks everyone out, while an
   *  attacker spread across many addresses is never counted individually.
   *
   *  Deliberately a hop COUNT and not `true`. Trusting every hop lets a client
   *  put whatever it likes at the front of X-Forwarded-For and be rate-limited
   *  as that instead. Set it to the number of proxies you actually run: 1 for
   *  a single nginx or Traefik, 2 behind Cloudflare in front of one of those. */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(0),

  /** --- Dev Containers ---------------------------------------------------
   *
   *  A project may carry `.devcontainer/devcontainer.json`, which is how a real
   *  repository says it needs ffmpeg, or a different Node, or a package this
   *  platform's three images do not have. See `containers/devcontainer.ts`. */

  /** Images a devcontainer may ask for, comma-separated.
   *
   *  An allowlist rather than "anything on Docker Hub", because `image` decides
   *  what code runs in the sandbox and pulling an arbitrary one is unbounded
   *  disk and bandwidth on top of a supply-chain decision nobody made. A
   *  trailing `*` is a prefix wildcard, so a deployment that trusts the
   *  Microsoft-maintained devcontainer images can say
   *  `mcr.microsoft.com/devcontainers/*` and mean it.
   *
   *  Defaults to this platform's own images, which is the conservative reading:
   *  a devcontainer can then still set env, ports, a workspace folder and
   *  install packages in postCreateCommand -- most of what one is for -- without
   *  the deployment having agreed to run somebody else's image. */
  DEVCONTAINER_IMAGE_ALLOWLIST: z
    .string()
    .default("sandbox-node:latest,sandbox-python:latest,sandbox-go:latest")
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),

  /** Longest a devcontainer's postCreate/postStart commands may run.
   *
   *  These sit directly in the path of opening a project, and they are
   *  arbitrary commands from a file in the repository -- so a `sleep infinity`
   *  in one must not be able to hold a start open forever. */
  DEVCONTAINER_LIFECYCLE_TIMEOUT_MINUTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10),

  PROJECTS_DIR: z.string().default("projects"),

  // Container resource budget. Defaults suit a 2-4 GB VM: 512 MB x 3 leaves
  // room for Postgres, the server, and the OS.
  CONTAINER_MEMORY_MB: z.coerce.number().int().positive().default(512),

  /** Whether language servers may be started inside project containers.
   *
   *  Off by default. §3.3's image cost — pyright pulls Node into the Python
   *  image — is paid on every cold start, including by people who never open
   *  a .py file, so switching this on is an operator's decision about their
   *  own images and their own VM. */
  LSP_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true" || value === "1"),

  /** Below this, a language server is refused rather than started.
   *
   *  §3.3: pyright idles at 150-300 MB on a real project and
   *  CONTAINER_MEMORY_MB defaults to 512, so a server started
   *  unconditionally would be competing with the dev server it exists to
   *  help. 1024 rather than 512+300 because the app needs headroom too —
   *  and an OOM kill of somebody's dev server is a far worse experience than
   *  an editor that says why it has no Python intelligence here. */
  LSP_MIN_CONTAINER_MEMORY_MB: z.coerce.number().int().positive().default(1024),
  CONTAINER_CPUS: z.coerce.number().positive().default(0.5),
  CONTAINER_IDLE_MINUTES: z.coerce.number().int().positive().default(20),
  /** Ceiling on a single project's working tree.
   *
   *  Containers get memory, CPU and PID limits; storage had none, and the
   *  project directory is a bind mount of a real host path — so one socket
   *  writing in a loop, or one runaway `npm install`, could fill the VM's disk
   *  and take Postgres and every other project down with it. */
  PROJECT_DISK_QUOTA_MB: z.coerce.number().int().positive().default(512),

  /** Periodic file snapshots, so an uncommitted mistake is recoverable.
   *
   *  On by default: §8 is right that "an uncommitted mistake is gone" is the
   *  scarier half of this product, and the cost is bounded by the retention
   *  window rather than open-ended. */
  CHECKPOINTS_ENABLED: z
    .string()
    .optional()
    .transform((value) => value !== "false" && value !== "0"),
  /** Disk a managed database's volume may hold, per project.
   *
   *  Its own line rather than sharing PROJECT_DISK_QUOTA_MB: a database is
   *  the easiest way in this whole product to fill a disk, and it fills a
   *  different one — a named Docker volume rather than the project tree. */
  DATABASE_DISK_QUOTA_MB: z.coerce.number().int().positive().default(1024),

  /** Per-user limits.
   *
   *  Only a global container cap existed, so one account could take every slot
   *  and fill the disk on its own. These bound what any single user costs the
   *  deployment, independently of how busy it is overall. */
  MAX_PROJECTS_PER_USER: z.coerce.number().int().positive().default(20),
  USER_DISK_QUOTA_MB: z.coerce.number().int().positive().default(2048),
  MAX_CONTAINERS_PER_USER: z.coerce.number().int().positive().default(2),
  MAX_CONCURRENT_CONTAINERS: z.coerce.number().int().positive().default(3),

  /** Start a project's dev server as soon as somebody opens it, instead of
   *  waiting for the Run button.
   *
   *  Every template's start command installs its dependencies first, so this
   *  covers `npm install` too — opening a project is meant to end with a live
   *  preview and nothing pressed.
   *
   *  Worth turning off on a small VM: it converts "opened a project" into "a
   *  container, an install and a dev server", which is a much larger commitment
   *  than viewing a file tree. An explicit Stop always wins over it, whatever
   *  this is set to. */
  AUTO_START_ON_OPEN: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  /** Force the sandboxes' file watchers to poll, or force them not to.
   *
   *  Unset means "work it out from the host" — see `shouldPollForChanges`.
   *  Worth setting explicitly for a host this cannot infer: WSL2 with the
   *  project on a Windows drive needs "true", a Linux box does not. */
  WATCH_POLLING: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),

  /** How the preview proxy reaches a project's dev server.
   *
   *  "container-ip"  -- dial the container's address on the sandbox network.
   *                    Requires the SERVER ITSELF to be on that network, i.e.
   *                    running under docker compose. This is the deployment
   *                    mode: nothing is published to the host at all.
   *  "host-loopback" -- publish the dev port on 127.0.0.1 and dial that.
   *                    Needed when the server runs directly on a Windows or
   *                    macOS host, where Docker Desktop gives the host no route
   *                    to container IPs. Still never binds 0.0.0.0.
   *
   *  Defaults by detecting whether we are inside a container. */
  PREVIEW_TARGET_MODE: z
    .enum(["container-ip", "host-loopback"])
    .optional(),

  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  /** Cookie policy for the refresh/preview cookies.
   *
   *  Same-origin or same-site deployments (frontend and API sharing a domain,
   *  e.g. the docker-compose.prod.yml VM setup) want "lax" -- it works over
   *  plain HTTP too. A split deployment where the frontend and API are on
   *  DIFFERENT domains (e.g. Vercel + a separate API host) MUST use "none",
   *  which browsers only honour together with Secure, i.e. HTTPS on both
   *  sides. Getting this wrong doesn't error -- it just makes login silently
   *  fail because the browser drops the cookie. */
  COOKIE_SAME_SITE: z.enum(["lax", "none"]).default("lax"),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    "Invalid environment configuration:\n" +
      parsed.error.issues
        .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
        .join("\n"),
  );
  process.exit(1);
}

export const env = parsed.data;

/** Absolute root holding every project's working tree.
 *
 *  Resolved once at startup so a later `process.chdir` cannot move it, and so
 *  path confinement has a stable anchor to compare against.
 */
export const PROJECTS_ROOT: string = path.resolve(env.PROJECTS_DIR);

export const isProduction = env.NODE_ENV === "production";

/** Where previews are served, or 0 to keep them on the API's own origin. */
export const previewPort: number = env.PREVIEW_PORT ?? env.PORT + 1;

/** Where published deployments are served, or 0 when the feature is off. */
export const deployPort: number = env.DEPLOY_PORT ?? env.PORT + 2;

/** Absolute root holding every published site.
 *
 *  Resolved at startup for the same reason PROJECTS_ROOT is: path confinement
 *  needs an anchor that a later `process.chdir` cannot move.
 */
export const DEPLOYMENTS_ROOT: string = path.resolve(env.DEPLOYMENTS_DIR);

/** The public origin deployments hang off, as a parsed URL.
 *
 *  Falls back to localhost on the deploy port, which is what makes the feature
 *  work out of the box: browsers resolve *.localhost themselves.
 */
export const deployOrigin: URL = new URL(
  env.DEPLOY_ORIGIN ?? `http://localhost:${String(deployPort)}`,
);

/** True when deployments are configured at all. */
export const deploymentsEnabled: boolean = deployPort !== 0;

/** True when this process is itself running inside a container. */
const runningInContainer = existsSync("/.dockerenv");

export const previewTargetMode: "container-ip" | "host-loopback" =
  env.PREVIEW_TARGET_MODE ??
  (runningInContainer ? "container-ip" : "host-loopback");

/** Whether a project's dev server has to poll to notice a saved file. */
export const watchPolling: boolean = shouldPollForChanges({
  override: env.WATCH_POLLING,
  inContainer: runningInContainer,
  platform: process.platform,
});

/** Container environment that turns polling on, or nothing at all. Spread into
 *  the `Env` of anything that starts a dev server. */
export const watchPollingEnv: string[] = pollingEnv(watchPolling);
