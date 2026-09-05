import fs from "node:fs/promises";
import { ensureContainer, removeContainer } from "../containers/containerManager.js";
import { execCapture } from "../containers/execCapture.js";
import { increment } from "../lib/metrics.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { claimForSandbox, projectRoot } from "../utils/projectPaths.js";
import {
  detectPackageManager,
  detectStartCommand,
  inspectDirectory,
} from "./repoImportService.js";

/** Building a project with the upstream scaffolder instead of a copy.
 *
 *  A committed starter directory is pinned to whatever was committed: ask for
 *  React today and you get the React of the day somebody added the folder.
 *  "Latest" runs the tool the ecosystem actually publishes — `npm create
 *  vite@latest` — so the project is current on the day it is made.
 *
 *  **Inside the container, never on the host**, and that is the whole reason
 *  this is a service rather than three lines in `createProjectService`. The
 *  original code shelled out to `npm create` on the host; the comment at
 *  `projectService.ts:82` records why it was removed — an arbitrary command
 *  outside any sandbox, needing the network, producing a nested directory so
 *  the bind-mount root and the app root disagreed by one level. All three are
 *  answered by running it where every other piece of user-adjacent code
 *  already runs. `importRepository` is the precedent and this follows it
 *  closely.
 *
 *  **The commands live in the database and are argv arrays.** A recipe is
 *  data — `npm create vite@latest` changes what it produces and which flags it
 *  takes without anybody here deploying — but it is passed to `docker exec` as
 *  an array and is never seen by a shell, which is what keeps a table of
 *  commands from being a remote code execution surface with extra steps. No
 *  route writes that table; a user picks a template, never a command.
 */

/** Where a project's files live inside its container. */
const APP_DIR = "/home/sandbox/app";

/** How long one command in a recipe may run.
 *
 *  A cold `create-next-app` on a slow link genuinely takes minutes, and cutting
 *  it off at one would make this feature a thing that never finishes. Somebody
 *  IS waiting on this one — unlike a prebuild — but they are waiting on a card
 *  that says so, not on an HTTP request.
 */
const STEP_TIMEOUT_MS = 8 * 60 * 1000;

export interface ScaffoldRecipe {
  templateId: string;
  label: string;
  argv: string[][];
}

/** Reads a recipe, refusing anything that is not the shape it must be.
 *
 *  `argv` is a JSON column, so the type system has nothing to say about what
 *  is actually in it — and this is the value that becomes a command. Validated
 *  here, once, rather than trusted because it came from our own database: a
 *  migration typo would otherwise reach `docker exec` as `undefined`.
 */
export function parseRecipe(row: {
  templateId: string;
  label: string;
  argv: unknown;
}): ScaffoldRecipe | null {
  if (!Array.isArray(row.argv) || row.argv.length === 0) return null;

  const argv: string[][] = [];
  for (const step of row.argv) {
    if (!Array.isArray(step) || step.length === 0) return null;
    if (!step.every((word) => typeof word === "string" && word.length > 0)) return null;
    argv.push(step as string[]);
  }

  return { templateId: row.templateId, label: row.label, argv };
}

/** The recipe for a template, or null when it has none or it is turned off. */
export async function recipeFor(templateId: string): Promise<ScaffoldRecipe | null> {
  const row = await prisma.scaffoldRecipe.findUnique({
    where: { templateId },
    select: { templateId: true, label: true, argv: true, enabled: true },
  });

  if (!row?.enabled) return null;

  const recipe = parseRecipe(row);
  if (!recipe) {
    // A row that cannot be read is an operator's mistake, not a user's, and it
    // must not look like "this template has no latest option" -- that would
    // hide the typo for as long as nobody looked.
    logger.error("a scaffold recipe is not a list of argv arrays", null, {
      templateId,
    });
  }

  return recipe;
}

/** Which templates can offer "Latest", for the picker.
 *
 *  Asked of the database rather than hard-coded in the UI, so turning a broken
 *  recipe off also removes the option that would fail.
 */
export async function templatesWithRecipes(): Promise<Set<string>> {
  const rows = await prisma.scaffoldRecipe.findMany({
    where: { enabled: true },
    select: { templateId: true },
  });

  return new Set(rows.map((row) => row.templateId));
}

function withTimeout<T>(work: Promise<T>, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      resolve(fallback);
    }, STEP_TIMEOUT_MS);
    timer.unref?.();

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** The last few lines of output, which is the part worth keeping.
 *
 *  A failing `npm install` produces tens of kilobytes and says what went wrong
 *  in the last twenty lines. Storing all of it would put an unbounded string in
 *  a row that is read by a dashboard.
 */
export function tail(text: string, lines = 40): string {
  const trimmed = text.trimEnd();
  if (!trimmed) return "";
  return trimmed.split("\n").slice(-lines).join("\n").slice(-8000);
}

async function fail(projectId: string, log: string): Promise<void> {
  increment("scaffolds_failed");
  await prisma.project
    .update({
      where: { id: projectId },
      data: { scaffoldStatus: "FAILED", scaffoldLog: tail(log) },
    })
    .catch((error: unknown) => {
      logger.error("could not mark a scaffold failed", error, { projectId });
    });
}

/** Runs a recipe against a project that has already been created.
 *
 *  Never throws: it is called without anybody awaiting it, so a rejection would
 *  be an unhandled one. Every failure path ends at `fail`, which is what the
 *  dashboard reads.
 *
 *  **Does not delete the project on failure**, unlike `importRepository`. The
 *  difference is that an import has nothing to show for itself if the clone
 *  fails, while a failed scaffold leaves a row somebody can read the reason
 *  from and retry — and deleting it would take the reason with it.
 */
export async function runScaffold(
  projectId: string,
  recipe: ScaffoldRecipe,
): Promise<boolean> {
  try {
    const container = await ensureContainer(projectId);

    for (const argv of recipe.argv) {
      logger.info("scaffolding", { projectId, command: argv[0] });

      const result = await withTimeout(
        execCapture(container, argv, {
          workingDir: APP_DIR,
          // Scaffolders ask questions when they think a person is there, and
          // there is nobody at the other end of an exec to answer them.
          env: { CI: "1", npm_config_yes: "true" },
        }),
        null,
      );

      if (!result) {
        await fail(
          projectId,
          `\`${argv.join(" ")}\` was still running after ` +
            `${String(STEP_TIMEOUT_MS / 60000)} minutes and was stopped.`,
        );
        return false;
      }

      if (result.exitCode !== 0) {
        // The scaffolder's own words. It is the only thing here that knows
        // why -- "creation failed" is not something anybody can act on and
        // "npm ERR! network timeout" is.
        await fail(projectId, result.stderr || result.stdout || "The command failed.");
        return false;
      }
    }

    // The scaffolder wrote as the container's user; the server has to be able
    // to read what it produced.
    const dir = projectRoot(projectId);
    await claimForSandbox(dir).catch(() => {});

    // What the scaffolder produced, not what the template assumed. Its own
    // package.json is the authority on how to run it, and its lockfile on how
    // to install it -- the same reconcile the import path does, for the same
    // reason.
    const { files, packageJson } = await inspectDirectory(dir);
    const startCommand = detectStartCommand(packageJson, detectPackageManager(files));

    await prisma.project.update({
      where: { id: projectId },
      data: {
        scaffoldStatus: "READY",
        scaffoldLog: null,
        ...(startCommand ? { startCommand } : {}),
      },
    });

    increment("scaffolds_completed");
    logger.info("project scaffolded", { projectId, template: recipe.templateId });
    return true;
  } catch (error) {
    logger.error("a scaffold failed", error, { projectId });
    await fail(projectId, "Something went wrong while building this project.");
    return false;
  }
}

/** The message a project gets when the server died while building it.
 *
 *  Says what is and is not known, because the alternative -- a project stuck
 *  on "Setting up" for ever -- is the wedge plan.md §2.26 already fixed twice,
 *  once for scheduled runs and once for deployments. This is the third place
 *  the same shape appeared, and it was written with the reconcile from the
 *  start rather than after somebody noticed.
 */
export const ABANDONED_SCAFFOLD =
  "The server restarted while this project was being built. Whatever the " +
  "scaffolder had finished is still in the project; delete it and try again, " +
  "or open it and see what is there.";

/** Fails every scaffold that was in flight when the process stopped.
 *
 *  A `SCAFFOLDING` row means a container exec this process was awaiting, and
 *  nothing survives the process to finish it or to notice. Rows and not
 *  containers, deliberately: the row is what the dashboard reads, so the row is
 *  what has to be true.
 */
export async function reconcileScaffolds(): Promise<number> {
  const { count } = await prisma.project.updateMany({
    where: { scaffoldStatus: "SCAFFOLDING" },
    data: { scaffoldStatus: "FAILED", scaffoldLog: ABANDONED_SCAFFOLD },
  });

  if (count > 0) logger.info("scaffolds abandoned by a restart", { count });
  return count;
}

/** Starts again, on a project that failed.
 *
 *  The working tree is emptied first. A scaffolder that got half way leaves
 *  files behind, and `npm create` refuses a directory it considers non-empty --
 *  so a retry without this fails for a reason that has nothing to do with why
 *  the first attempt did.
 */
export async function retryScaffold(
  projectId: string,
  templateId: string,
): Promise<boolean> {
  const recipe = await recipeFor(templateId);
  if (!recipe) return false;

  const dir = projectRoot(projectId);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(dir, { recursive: true });
  await claimForSandbox(dir).catch(() => {});

  // The container has the old attempt's writable layer and, more importantly,
  // may be the wrong image if the template changed. Cheaper to rebuild than to
  // reason about what is left in it.
  await removeContainer(projectId).catch(() => {});

  await prisma.project.update({
    where: { id: projectId },
    data: { scaffoldStatus: "SCAFFOLDING", scaffoldLog: null },
  });

  return runScaffold(projectId, recipe);
}
