import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { BadRequestError } from "../utils/errors.js";

/** Per-project environment variables.
 *
 *  Stored on the project row rather than in a dotfile in the working tree, so
 *  they are not committed by the user's own git, not included in an export, and
 *  not readable through the file tree.
 *
 *  Docker fixes a container's environment when it is CREATED, and a stopped
 *  container is reused rather than rebuilt — so for a while these took effect
 *  only on a project that had never been opened. Containers now carry a label
 *  recording which set they were built with, and one holding a stale set is
 *  rebuilt on its next start. Restart is the shortest way to reach that.
 */

/** POSIX-ish: a name the shell can actually export. */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names the platform sets itself. Letting a project override these would let
 *  it point its own dev server somewhere the proxy cannot reach, or shadow the
 *  home directory the package caches live under. */
const RESERVED = new Set(["HOME", "PATH", "HOSTNAME", "PREVIEW_BASE", "DEV_PORT"]);

const MAX_VARIABLES = 100;
const MAX_VALUE_LENGTH = 4096;

export const envVarsSchema = z
  .record(
    z.string().regex(NAME_PATTERN, "Names must look like MY_VARIABLE"),
    z.string().max(MAX_VALUE_LENGTH, "Value is too long"),
  )
  .refine(
    (value) => Object.keys(value).length <= MAX_VARIABLES,
    `At most ${String(MAX_VARIABLES)} variables`,
  )
  .refine(
    (value) => Object.keys(value).every((name) => !RESERVED.has(name)),
    `These names are set by the platform: ${[...RESERVED].join(", ")}`,
  );

export type EnvVars = z.infer<typeof envVarsSchema>;

/** Reads a project's variables, tolerating a row written before this existed
 *  or by hand. */
export function parseEnvVars(raw: unknown): EnvVars {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};

  const result: EnvVars = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && NAME_PATTERN.test(name)) {
      result[name] = value;
    }
  }

  return result;
}

export async function getEnvVars(projectId: string): Promise<EnvVars> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { envVars: true },
  });

  return parseEnvVars(project?.envVars);
}

export async function setEnvVars(
  projectId: string,
  vars: unknown,
): Promise<EnvVars> {
  const parsed = envVarsSchema.safeParse(vars);

  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
      "INVALID_ENV_VARS",
    );
  }

  await prisma.project.update({
    where: { id: projectId },
    data: { envVars: parsed.data },
  });

  return parsed.data;
}

/** Renders the variables as Docker's `NAME=value` list. */
export function toDockerEnv(vars: EnvVars): string[] {
  return Object.entries(vars).map(([name, value]) => `${name}=${value}`);
}
