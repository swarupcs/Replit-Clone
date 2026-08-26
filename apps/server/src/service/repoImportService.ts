import fs from "node:fs/promises";
import path from "node:path";
import type { Project } from "../generated/prisma/client.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { ensureContainer, removeContainer } from "../containers/containerManager.js";
import { execCapture } from "../containers/execCapture.js";
import { claimForSandbox, projectRoot } from "../utils/projectPaths.js";
import { BadRequestError } from "../utils/errors.js";
import { assertCanCreateProject } from "./userQuotaService.js";
import { githubToken, type GithubRepo } from "./githubService.js";

const APP_DIR = "/home/sandbox/app";

/** The image used to clone, before anything is known about the repository.
 *
 *  A template decides what *runs*; it does not have to match to hold the files.
 *  This one has git, so it is what does the fetching, and the real template is
 *  set from what arrived.
 */
const IMPORT_TEMPLATE = "node-express";

/** Recognising a project from the files it has.
 *
 *  Pure, and separate from the clone, because this is the part with rules in
 *  it — and because testing it should not need Docker, a network, or a
 *  repository.
 *
 *  Deliberately ordered: a Next.js app is also a React app, and a repository
 *  with both `next.config.js` and `react` in its dependencies is a Next.js one.
 */
export function detectTemplate(
  files: string[],
  packageJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null,
): string {
  const has = (name: string) => files.includes(name);
  const deps = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  };
  const dep = (name: string) => name in deps;
  const typescript = has("tsconfig.json") || dep("typescript");

  if (has("go.mod")) return "go-http";

  if (has("requirements.txt") || has("pyproject.toml") || has("Pipfile")) {
    // Which Python framework matters: the two templates differ in start
    // command and port, and getting it wrong means a preview that never comes
    // up. Read from the file rather than guessed.
    return files.includes("__fastapi__") ? "python-fastapi" : "python-flask";
  }

  if (packageJson) {
    if (has("next.config.js") || has("next.config.mjs") || has("next.config.ts") || dep("next")) {
      return typescript ? "nextjs-ts" : "nextjs";
    }
    if (dep("vue")) return "vue-vite";
    if (dep("svelte") || dep("@sveltejs/kit")) return "svelte-vite";
    if (dep("react")) return typescript ? "react-vite-ts" : "react-vite";
    if (dep("express") || dep("fastify") || dep("koa")) {
      return typescript ? "node-express-ts" : "node-express";
    }

    // A package.json and nothing recognisable: it is a Node project of some
    // kind, and the Node image is the one that can install and run it.
    return typescript ? "node-express-ts" : "node-express";
  }

  if (has("index.html")) return "static-html";

  // Nothing recognisable. The Node image is the most generally useful thing to
  // hand someone: it has git, a shell and a package manager.
  return IMPORT_TEMPLATE;
}

/** Reads what the clone left behind, for `detectTemplate`. */
async function inspectClone(dir: string): Promise<{
  files: string[];
  packageJson: Record<string, unknown> | null;
}> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);

  let packageJson: Record<string, unknown> | null = null;
  try {
    const raw = await fs.readFile(path.join(dir, "package.json"), "utf8");
    packageJson = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // No package.json, or one that is not valid JSON. Either way there is
    // nothing to read from it, and a broken one is not a reason to fail an
    // import that otherwise worked.
  }

  const files = [...entries];

  // A marker rather than a second parameter, so `detectTemplate` stays a
  // function of the file list. Flask and FastAPI are told apart by what the
  // requirements actually name.
  const requirements = await fs
    .readFile(path.join(dir, "requirements.txt"), "utf8")
    .catch(() => "");
  const pyproject = await fs
    .readFile(path.join(dir, "pyproject.toml"), "utf8")
    .catch(() => "");

  if (/fastapi/i.test(requirements + pyproject)) files.push("__fastapi__");

  return { files, packageJson };
}

/** The credential helper used for a clone of a private repository.
 *
 *  The token travels in the environment rather than in the URL or the argv:
 *  process arguments are world-readable through /proc, and a URL with a token
 *  in it would be written into `.git/config` as the remote.
 */
const TOKEN_CREDENTIAL_HELPER =
  '!f() { echo username=token; echo "password=$RC_GIT_TOKEN"; }; f';

export interface ImportRequest {
  owner: string;
  repo: string;
  /** Branch or tag. The repository's default when absent. */
  ref?: string;
  /** What to call the project here. The repository's name when absent. */
  name?: string;
}

/** GitHub's own naming rules, applied before the value reaches a command line
 *  or a URL. Anything outside this is not a repository we could clone anyway. */
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
/** A ref that git will accept and that cannot be read as an option. */
const REF_PATTERN = /^[A-Za-z0-9._\-/]+$/;

function assertNameable(value: string, what: string): void {
  if (!NAME_PATTERN.test(value) || value.startsWith("-") || value.length > 100) {
    throw new BadRequestError(`That ${what} is not a valid GitHub name.`, "BAD_REPO");
  }
}

/** Refuses a repository that cannot fit before anything is downloaded.
 *
 *  GitHub reports the size, so this is answerable up front — which is much
 *  better than filling the disk and cleaning up after.
 */
function assertFits(sizeKb: number): void {
  const limitKb = env.PROJECT_DISK_QUOTA_MB * 1024;

  // The working tree is roughly the repository again beside `.git`, so the
  // usable ceiling is about half the quota. Approximate on purpose: the point
  // is to refuse the obviously-too-big, not to predict the exact size.
  if (sizeKb * 2 > limitKb) {
    throw new BadRequestError(
      `That repository is about ${String(Math.round(sizeKb / 1024))} MB, which ` +
        `does not fit in this server's ${String(env.PROJECT_DISK_QUOTA_MB)} MB ` +
        `per-project limit.`,
      "REPO_TOO_LARGE",
    );
  }
}

/** Clones a repository into a new project.
 *
 *  The clone runs inside the project's own container, through the same exec
 *  path every other git call uses — not on the host. A URL from a browser
 *  driving a network fetch on the host is exactly what that boundary exists to
 *  prevent, and a brand-new project has no collaborators and no share link, so
 *  the rule that governs pushing is satisfied by construction.
 */
export async function importRepository(
  userId: string,
  request: ImportRequest,
  repo: GithubRepo,
): Promise<Project> {
  assertNameable(request.owner, "owner");
  assertNameable(request.repo, "repository");

  const ref = request.ref?.trim();
  if (ref && (!REF_PATTERN.test(ref) || ref.startsWith("-"))) {
    throw new BadRequestError("That branch or tag name is not valid.", "BAD_REF");
  }

  assertFits(repo.sizeKb);
  await assertCanCreateProject(userId);

  const token = await githubToken(userId);

  const project = await prisma.project.create({
    data: {
      name: request.name?.trim() || repo.name,
      ownerId: userId,
      // Replaced below with whatever the files turn out to be. This one is here
      // because it has git.
      template: IMPORT_TEMPLATE,
    },
  });

  const dir = projectRoot(project.id);

  try {
    await fs.mkdir(dir, { recursive: true });
    await claimForSandbox(dir).catch(() => {});

    const container = await ensureContainer(project.id);

    // The URL is built here from a name the API gave us, never taken as a
    // string from the browser — which is what removes the `ext::`-transport
    // question rather than answering it.
    const url = `https://github.com/${request.owner}/${request.repo}.git`;

    const argv = [
      "git",
      "-c",
      `credential.helper=${TOKEN_CREDENTIAL_HELPER}`,
      "clone",
      // Submodules can point anywhere, including at a local path; fetching
      // them is a decision, not a default.
      "--no-recurse-submodules",
      ...(ref ? ["--branch", ref] : []),
      "--",
      url,
      ".",
    ];

    const result = await execCapture(container, argv, {
      workingDir: APP_DIR,
      env: { RC_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: "0" },
    });

    if (result.exitCode !== 0) {
      // git puts the URL in its errors, and the credential helper means the
      // token is not in the URL — but the message is passed through a redactor
      // anyway, because being wrong about that is expensive.
      throw new BadRequestError(
        redact(result.stderr || "The clone failed.", token),
        "CLONE_FAILED",
      );
    }

    const { files, packageJson } = await inspectClone(dir);
    const template = detectTemplate(files, packageJson);

    if (template !== IMPORT_TEMPLATE) {
      await prisma.project.update({
        where: { id: project.id },
        data: { template },
      });

      // The image is chosen when the container starts, so the one that did the
      // cloning is the wrong one for what was cloned. Removed rather than
      // reused; the next open starts the right image.
      await removeContainer(project.id).catch(() => {});
    }

    // Ownership again: the clone wrote as the container's user, and anything
    // the server does afterwards has to be able to read it.
    await claimForSandbox(dir).catch(() => {});

    logger.info("repository imported", {
      projectId: project.id,
      repo: repo.fullName,
      template,
    });

    return { ...project, template };
  } catch (error) {
    // Never leave a row pointing at a directory that was not populated.
    await removeContainer(project.id).catch(() => {});
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Belt and braces on anything git says on the way back out. */
function redact(text: string, token: string): string {
  return token ? text.split(token).join("***") : text;
}
