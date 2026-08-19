import path from "node:path";
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

  REACT_PROJECT_COMMAND: z.string().optional(),

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
