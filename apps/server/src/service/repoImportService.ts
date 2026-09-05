import fs from "node:fs/promises";
import path from "node:path";
import type { Project } from "../generated/prisma/client.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { previewBaseFor } from "./previewContract.js";
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

/** The command that runs an imported repository.
 *
 *  A template's start command is right for a project scaffolded from that
 *  template and usually wrong for somebody's real repository — the registry has
 *  a fixed dozen templates and a real project's own script is not among them.
 *  So it is read from `package.json`.
 *
 *  Ordered by what a dev server is most often called. `start` is deliberately
 *  not first: in a Vite or Next project it usually means the *production*
 *  server, which needs a build that has not happened.
 *
 *  Null when there is nothing to go on, which leaves the template's default —
 *  a wrong guess is worse than the default, because the default is at least
 *  predictable from the template shown in the UI.
 */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Which package manager a cloned repository is actually using.
 *
 *  **The lockfile decides, not `packageManager` in package.json**, because the
 *  lockfile is the thing that exists in every case: the `packageManager` field
 *  is corepack-era and most repositories still do not carry one, while a repo
 *  with no lockfile at all is genuinely an npm repo by default.
 *
 *  This existing at all is the fix for a real defect. `warmStart` fingerprints
 *  `pnpm-lock.yaml` and `yarn.lock` and knows how to skip a `pnpm install` --
 *  but nothing ever *produced* such a command, because the function below
 *  emitted `npm install` whatever had just been cloned. So the lockfile was
 *  ignored (the point of a lockfile), and a `workspace:*` dependency, which npm
 *  cannot resolve at all, failed outright.
 *
 *  Order matters where a repository carries more than one lockfile, which
 *  happens after a migration somebody did not finish. The newer tool wins,
 *  because a stale `package-lock.json` left behind by a move TO pnpm is the
 *  common case and the reverse is not.
 */
export function detectPackageManager(files: string[]): PackageManager {
  const present = new Set(files);

  if (present.has("bun.lockb") || present.has("bun.lock")) return "bun";
  if (present.has("pnpm-lock.yaml")) return "pnpm";
  if (present.has("yarn.lock")) return "yarn";
  return "npm";
}

/** How each manager installs, and how it runs a script.
 *
 *  `yarn` takes no `run` for a script name and `bun` prefers `bun run`; getting
 *  this wrong produces a command that fails with a usage message rather than
 *  anything a person can act on.
 */
const COMMANDS: Record<
  PackageManager,
  {
    install: string;
    run: (script: string) => string;
    /** How this manager hands extra arguments to the script it runs.
     *
     *  npm is the odd one and the reason this exists: it consumes flags itself
     *  unless they follow a bare `--`. The other three forward whatever comes
     *  after the script name, and pnpm in particular warns about a `--` it does
     *  not need. Getting this wrong does not misconfigure the dev server, it
     *  stops it starting. */
    forward: (args: string) => string;
  }
> = {
  npm: {
    install: "npm install",
    run: (script) => `npm run ${script}`,
    forward: (args) => `-- ${args}`,
  },
  pnpm: {
    install: "pnpm install",
    run: (script) => `pnpm run ${script}`,
    forward: (args) => args,
  },
  // `yarn install` covers both Classic and Berry; `yarn <script>` is the form
  // both understand.
  yarn: {
    install: "yarn install",
    run: (script) => `yarn ${script}`,
    forward: (args) => args,
  },
  bun: {
    install: "bun install",
    run: (script) => `bun run ${script}`,
    forward: (args) => args,
  },
};

/** Flags that make somebody else's dev server reachable through the preview
 *  proxy. plan.md §2.43's other half.
 *
 *  **The scaffold path solves this by writing our config into the project. That
 *  answer is wrong here**, and the difference is the whole reason this is a
 *  separate mechanism: a scaffolded project's config is thirty seconds old and
 *  contains a framework plugin, while an imported repository's config is
 *  somebody's actual work and may carry aliases, proxies and build settings
 *  that this platform has no business replacing. So nothing here writes to a
 *  file. Everything is a flag on the command that this platform already owns.
 *
 *  What that costs, and it is worth saying rather than discovering: these
 *  arrive through the **stored start command**, so they apply when the project
 *  is started by Run. A dev server started by typing `npm run dev` in the
 *  terminal is the repository's own command and is not reachable by the
 *  preview. There is no way to fix that without editing their files, which is
 *  the thing this deliberately does not do.
 *
 *  Matched on the START of the script rather than anywhere in it. A script like
 *  `concurrently "vite" "node api"` mentions vite and would receive the flags
 *  itself, which is how a dev server stops starting at all.
 */
const PREVIEW_FLAGS: {
  matches: RegExp;
  flags: (base: string | null) => string[];
}[] = [
  {
    matches: /^vite(\s|$)/,
    // Vite takes both as flags, which is what makes an imported Vite app
    // fixable at all without touching its config. Ours come last, so they win
    // over anything the repository's own script set.
    flags: (base) => [
      "--host",
      "0.0.0.0",
      ...(base === null ? [] : ["--base", base]),
    ],
  },
  {
    // Next binds every interface by default on recent versions; stating it
    // costs nothing and covers the ones that did not.
    //
    // `basePath` is deliberately absent, because Next has no flag for it -- it
    // is config-only. An imported Next app whose template expects the preview
    // base therefore still serves its assets from the wrong place, and that is
    // a real gap rather than an oversight.
    matches: /^next\s+dev(\s|$)/,
    flags: () => ["--hostname", "0.0.0.0"],
  },
];

/** Whether this dev script's tool can be told the preview base on the command
 *  line at all.
 *
 *  Vite can (`--base`). Next cannot -- `basePath` is config-only -- so an
 *  imported Next app cannot be made to serve under the prefix without editing
 *  a file this path deliberately does not touch. The answer for those is the
 *  other direction: record `expectsPreviewBase: false` on the project so the
 *  proxy strips the prefix instead, and let `previewAssetGuard` catch the
 *  absolute asset URLs that then land at the origin root.
 *
 *  A tool this does not recognise returns true, which means "change nothing".
 *  An unknown dev server is more likely to be a plain server serving relative
 *  paths than a bundler, and its template's own answer is a better guess than
 *  one made here.
 */
export function canSetPreviewBase(script: string): boolean {
  return !/^next\s+dev(\s|$)/.test(script.trim());
}

/** The flags for one dev script, or none when its tool is not one we know.
 *
 *  Exported for its tests: the interesting cases are the ones where it must
 *  stay silent, and those are hard to see through `detectStartCommand`.
 */
export function previewFlagsFor(script: string, base: string | null): string[] {
  const trimmed = script.trim();
  const rule = PREVIEW_FLAGS.find((entry) => entry.matches.test(trimmed));
  return rule ? rule.flags(base) : [];
}

/** The dev script a project would be started with, by the same rules
 *  `detectStartCommand` uses. Exported so a caller can ask about the script
 *  itself -- `canSetPreviewBase` needs it -- without re-deriving the choice
 *  and risking the two disagreeing. */
export function devScriptOf(
  packageJson: { scripts?: Record<string, string> } | null,
): string | null {
  const scripts = packageJson?.scripts;
  if (!scripts) return null;
  const chosen = ["dev", "develop", "start", "serve"].find(
    (name) => typeof scripts[name] === "string" && scripts[name].trim(),
  );
  return chosen ? (scripts[chosen] ?? null) : null;
}

export function detectStartCommand(
  packageJson: { scripts?: Record<string, string> } | null,
  manager: PackageManager = "npm",
  /** Where the preview proxy serves this project, when its template expects
   *  the app to know. Null for a template the proxy strips the prefix for, and
   *  omitted entirely by the scaffold path -- whose config carries the base
   *  already, and would otherwise be given it twice. */
  previewBase?: string | null,
): string | null {
  const scripts = packageJson?.scripts;
  if (!scripts) return null;

  const chosen = ["dev", "develop", "start", "serve"].find(
    (name) => typeof scripts[name] === "string" && scripts[name].trim(),
  );

  if (!chosen) return null;

  // The install is part of it: a freshly cloned repository has no node_modules,
  // and a run that fails on a missing dependency looks like a broken import.
  //
  // And it is the RIGHT install: `warmStart`'s INSTALL_PREFIXES already knows
  // every one of these, so an imported pnpm project takes the warm-start path
  // from here on -- which it never could while this always said npm.
  const commands = COMMANDS[manager];
  const run = commands.run(chosen);

  // Only for a caller that asked. `undefined` means "do not touch the command",
  // which is not the same as `null` -- that means "reachable, but the proxy
  // strips the prefix, so no base".
  if (previewBase === undefined) return `${commands.install} && ${run}`;

  // `?? ""` only to satisfy the index signature: `chosen` came from a find
  // that already established this is a non-empty string.
  const flags = previewFlagsFor(scripts[chosen] ?? "", previewBase);
  const withFlags =
    flags.length > 0 ? `${run} ${commands.forward(flags.join(" "))}` : run;

  return `${commands.install} && ${withFlags}`;
}

/** Reads a directory's top level, for `detectTemplate`.
 *
 *  Written for a fresh clone and exported once opening a folder needed the
 *  same answer about a directory that was already there. The question is
 *  identical -- "what kind of project is this" -- and the alternative was a
 *  second detector that would drift from this one. */
export async function inspectDirectory(dir: string): Promise<{
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

    const { files, packageJson } = await inspectDirectory(dir);
    const template = detectTemplate(files, packageJson);
    // The lockfile that was just cloned decides how this project installs.
    const manager = detectPackageManager(files);
    // The repository's own command, plus whatever it takes to make its dev
    // server reachable through the proxy. Nothing is written to the clone --
    // see `previewFlagsFor` for why this path answers differently from the
    // scaffold path.
    const startCommand = detectStartCommand(
      packageJson,
      manager,
      previewBaseFor(template, project.id),
    );

    // False only where the flags above could not deliver the base, which
    // today means Next: the proxy strips the prefix instead, and
    // `previewAssetGuard` catches the absolute asset URLs that then arrive at
    // the origin root. Left null otherwise, so the template keeps answering.
    const expectsPreviewBase =
      previewBaseFor(template, project.id) !== null &&
      !canSetPreviewBase(devScriptOf(packageJson) ?? "")
        ? false
        : null;

    if (template !== IMPORT_TEMPLATE || startCommand || expectsPreviewBase !== null) {
      await prisma.project.update({
        where: { id: project.id },
        data: {
          template,
          ...(startCommand ? { startCommand } : {}),
          ...(expectsPreviewBase === null ? {} : { expectsPreviewBase }),
        },
      });
    }

    if (template !== IMPORT_TEMPLATE) {

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

    return { ...project, template, startCommand };
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
