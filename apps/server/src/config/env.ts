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

  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),

  PROJECTS_DIR: z.string().default("projects"),

  // Container resource budget. Defaults suit a 2-4 GB VM: 512 MB x 3 leaves
  // room for Postgres, the server, and the OS.
  CONTAINER_MEMORY_MB: z.coerce.number().int().positive().default(512),
  CONTAINER_CPUS: z.coerce.number().positive().default(0.5),
  CONTAINER_IDLE_MINUTES: z.coerce.number().int().positive().default(20),
  MAX_CONCURRENT_CONTAINERS: z.coerce.number().int().positive().default(3),

  /** How the preview proxy reaches a project's dev server.
   *
   *  "container-ip"  — dial the container's address on the sandbox network.
   *                    Requires the SERVER ITSELF to be on that network, i.e.
   *                    running under docker compose. This is the deployment
   *                    mode: nothing is published to the host at all.
   *  "host-loopback" — publish the dev port on 127.0.0.1 and dial that.
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
