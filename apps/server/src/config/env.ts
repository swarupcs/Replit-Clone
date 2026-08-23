import path from "node:path";
import { existsSync } from "node:fs";
import dotenv from "dotenv";
import { z } from "zod";
import {
  pollingEnv,
  shouldPollForChanges,
} from "./fileWatching.js";

dotenv.config();

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

  WEB_ORIGIN: z.string().url().default("http://localhost:5273"),

  /** This server's own public origin. Needed because an OAuth redirect_uri has
   *  to be absolute and has to match what is registered with the provider. */
  API_ORIGIN: z.string().url().default("http://localhost:3000"),

  /** GitHub sign-in. Both empty means the feature is simply off. */
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),

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

  PROJECTS_DIR: z.string().default("projects"),

  // Container resource budget. Defaults suit a 2-4 GB VM: 512 MB x 3 leaves
  // room for Postgres, the server, and the OS.
  CONTAINER_MEMORY_MB: z.coerce.number().int().positive().default(512),
  CONTAINER_CPUS: z.coerce.number().positive().default(0.5),
  CONTAINER_IDLE_MINUTES: z.coerce.number().int().positive().default(20),
  /** Ceiling on a single project's working tree.
   *
   *  Containers get memory, CPU and PID limits; storage had none, and the
   *  project directory is a bind mount of a real host path — so one socket
   *  writing in a loop, or one runaway `npm install`, could fill the VM's disk
   *  and take Postgres and every other project down with it. */
  PROJECT_DISK_QUOTA_MB: z.coerce.number().int().positive().default(512),

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
