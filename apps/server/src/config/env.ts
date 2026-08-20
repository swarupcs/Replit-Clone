import path from "node:path";
import { existsSync } from "node:fs";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  TERMINAL_PORT: z.coerce.number().int().positive().default(4000),

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

  WEB_ORIGIN: z.string().url().default("http://localhost:5273"),

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
  MAX_CONCURRENT_CONTAINERS: z.coerce.number().int().positive().default(3),

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

/** True when this process is itself running inside a container. */
const runningInContainer = existsSync("/.dockerenv");

export const previewTargetMode: "container-ip" | "host-loopback" =
  env.PREVIEW_TARGET_MODE ??
  (runningInContainer ? "container-ip" : "host-loopback");
