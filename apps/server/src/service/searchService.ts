import { Worker } from "node:worker_threads";
import type {
  CrossProjectSearchResult,
  ProjectSearchHit,
  ReplaceOptions,
  SearchMatch,
  SearchOptions,
} from "@replit-clone/shared";
import { IGNORED_DIRECTORIES } from "./fileTreeService.js";
import { projectRoot } from "../utils/projectPaths.js";
import { AppError, BadRequestError } from "../utils/errors.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import { recordWrite } from "./diskUsageService.js";
import type {
  FileReplacement,
  SearchWorkerInput,
  SearchWorkerOutput,
} from "./searchWorker.js";

/** Search across a project's files.
 *
 *  Quick Open matches filenames only, so there was no way to find a symbol —
 *  the one thing you reach for constantly in a codebase you did not write.
 *
 *  Implemented in Node rather than shelling out to ripgrep: the server may not
 *  have it installed, and passing a user-supplied pattern to a subprocess is a
 *  category of bug worth not having.
 *
 *  The scan itself runs in a worker with a deadline. See searchWorker for why
 *  that is not optional: a user's own regex can take unbounded time on a
 *  single line, nothing can interrupt one mid-match, and on the main thread
 *  that stops the entire server rather than one search.
 */

/** Files bigger than this are skipped: they are minified bundles, lockfiles or
 *  binaries, and matching inside them helps nobody. */
const MAX_FILE_BYTES = 1024 * 1024;

/** Total matches returned. A query like "e" would otherwise try to return the
 *  entire project one line at a time. */
const MAX_MATCHES = 500;

/** Files opened. Bounds the work regardless of what the query is. */
const MAX_FILES_SCANNED = 5000;

const MAX_LINE_LENGTH = 400;

/** How long a scan may run before the worker is taken away.
 *
 *  Generous for an honest search over a large tree, and short enough that a
 *  pattern designed not to finish costs one thread for a few seconds instead
 *  of costing the deployment.
 */
const SEARCH_TIMEOUT_MS = 5000;

/** Longest pattern accepted. Backtracking cost grows with the expression as
 *  well as the input, and nobody searches with a kilobyte of regex. */
const MAX_QUERY_LENGTH = 1000;

/** Longest replacement accepted. It is pasted into every match, so its size
 *  multiplies across a rewrite in a way a search query's does not. */
const MAX_REPLACEMENT_LENGTH = 10_000;

/** Replace mode: files a single command may rewrite. */
const MAX_FILES_WRITTEN = 200;

/** Replace mode: total bytes one command may add. Shrinking never counts;
 *  the point is to bound how far a rewrite can inflate a project. */
const MAX_TOTAL_BYTES_ADDED = 32 * 1024 * 1024;

/** Escapes a string so it matches literally inside a RegExp. */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds the matcher, or throws when the user's own regex does not compile.
 *
 *  Compiled here, on the main thread, deliberately: compiling is cheap and
 *  safe, and it is only matching that can run away. Doing it here means a
 *  malformed expression comes back as the user's own mistake rather than as a
 *  worker that died for reasons nobody can see.
 */
export function buildPattern(options: SearchOptions): RegExp {
  if (options.query.length > MAX_QUERY_LENGTH) {
    throw new BadRequestError("That search is too long", "QUERY_TOO_LONG");
  }

  const source = options.isRegex ? options.query : escapeLiteral(options.query);
  const body = options.wholeWord ? `\\b(?:${source})\\b` : source;
  const flags = options.caseSensitive ? "g" : "gi";

  return new RegExp(body, flags);
}

/** A scan that hit its deadline. 408 rather than 500: the request was
 *  understood and is simply more work than this endpoint will do. */
export class SearchTimeoutError extends AppError {
  constructor() {
    super(
      408,
      "SEARCH_TIMEOUT",
      "That search took too long and was stopped. A simpler pattern will finish.",
    );
  }
}

export interface SearchResult {
  matches: SearchMatch[];
  /** True when a limit stopped the scan, so the UI can say the list is partial
   *  rather than implying it found everything. */
  truncated: boolean;
}

/** Resolves the worker's own file.
 *
 *  The extension is taken from this module's, because the two are always
 *  compiled together: `.ts` under tsx and vitest, `.js` in dist. Hardcoding
 *  either one works in exactly half the places this runs.
 */
function workerUrl(): URL {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./searchWorker${extension}`, import.meta.url);
}

export async function searchProject(
  projectId: string,
  options: SearchOptions,
): Promise<SearchResult> {
  if (options.query.trim().length === 0) {
    return { matches: [], truncated: false };
  }

  const pattern = buildPattern(options);

  const input: SearchWorkerInput = {
    root: projectRoot(projectId),
    ignored: [...IGNORED_DIRECTORIES],
    pattern: { source: pattern.source, flags: pattern.flags },
    limits: {
      maxFileBytes: MAX_FILE_BYTES,
      maxMatches: MAX_MATCHES,
      maxFilesScanned: MAX_FILES_SCANNED,
      maxLineLength: MAX_LINE_LENGTH,
    },
  };

  return runInWorker(input, projectId);
}

/** How many of a user's projects one cross-project search will open.
 *
 *  A cap and not a page: each project costs a worker, a directory walk and a
 *  share of the deadline, and somebody with two hundred projects asking for
 *  "TODO" should get a fast partial answer rather than a slow complete one.
 *  Newest first, so the cap falls on the projects least likely to be the one
 *  being looked for.
 */
const MAX_PROJECTS_SEARCHED = 25;

/** How many projects are scanned at once.
 *
 *  Each is a worker thread and a directory walk. Four rather than all of them
 *  because the point of this search is to answer quickly, and twenty-five
 *  concurrent walks on one disk answer more slowly than four do -- and would
 *  contend with whatever the user is actually running.
 */
const SEARCH_CONCURRENCY = 4;

/** The whole cross-project search's budget.
 *
 *  Longer than one project's, and much shorter than the sum: a search across
 *  everything is expected to take longer than a search across one thing, and
 *  is not allowed to take twenty-five times as long. Whatever has finished
 *  when this expires is returned, marked truncated.
 */
const CROSS_PROJECT_TIMEOUT_MS = 15_000;

/** Searches every project an account owns.
 *
 *  The question this answers is "which project did I write that in", which is
 *  the one question a per-project search cannot. `searchProject` had been the
 *  only entry point in this module, so every search in this product was inside
 *  one project.
 *
 *  Owned, not merely accessible. A global search box that reached into
 *  projects shared WITH you would quietly widen how far one keystroke sees --
 *  a collaborator invited to one file's worth of work would find their whole
 *  repository in somebody else's sidebar. Reaching a shared project is what
 *  opening it is for, and that path already checks access per project.
 *
 *  One project's failure is skipped rather than raised. A row whose working
 *  tree is missing -- §5 has found two -- would otherwise make every
 *  cross-project search fail for as long as it existed, and the failure would
 *  look like "that text is nowhere" rather than like a broken project.
 */
export async function searchAcrossProjects(
  ownerId: string,
  options: SearchOptions,
): Promise<CrossProjectSearchResult> {
  if (options.query.trim().length === 0) {
    return { projects: [], scanned: 0, total: 0, truncated: false };
  }

  const { prisma } = await import("../lib/prisma.js");
  const owned = await prisma.project.findMany({
    where: { ownerId, deletedAt: null },
    // Newest first, so the cap below falls on the projects least likely to be
    // the one being looked for.
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true },
  });

  const shortlist = owned.slice(0, MAX_PROJECTS_SEARCHED);
  const deadline = Date.now() + CROSS_PROJECT_TIMEOUT_MS;

  const hits: ProjectSearchHit[] = [];
  let matched = 0;
  let scanned = 0;
  let ranOut = false;

  // A shared cursor rather than chunked batches: projects differ enormously in
  // size, and a batch of four waits for its slowest member before starting the
  // next four.
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const project = shortlist[index];
      if (!project) return;

      // Checked per project rather than per batch, so a single slow one cannot
      // take the whole budget and then start another.
      if (Date.now() > deadline || matched >= MAX_MATCHES) {
        ranOut = true;
        return;
      }

      try {
        const result = await searchProject(project.id, options);
        scanned += 1;
        if (result.matches.length === 0) continue;

        matched += result.matches.length;
        hits.push({
          projectId: project.id,
          name: project.name,
          matches: result.matches,
          truncated: result.truncated,
        });
      } catch (error) {
        // Counted as scanned: it was looked at, and reporting otherwise would
        // make "scanned 9 of 10" mean two different things.
        scanned += 1;
        logger.warn("a project could not be searched", {
          projectId: project.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(SEARCH_CONCURRENCY, shortlist.length) }, () =>
      worker(),
    ),
  );

  // Ordered by where the most was found, not by when the project was last
  // touched: the question was which project, and the answer with eleven
  // matches is a better one than the answer with one.
  hits.sort((a, b) => b.matches.length - a.matches.length);

  return {
    projects: hits,
    scanned,
    total: owned.length,
    truncated: ranOut || owned.length > shortlist.length,
  };
}

export interface ReplaceResult {
  files: { relPath: string; replacements: number }[];
  replacements: number;
  /** True when a cap stopped the rewrite, so the caller knows to look again
   *  rather than trust the job finished. */
  truncated: boolean;
}

/** Replaces every match of the search across the project's files.
 *
 *  Runs under the same worker and deadline as search: the matching is
 *  identical, and it can run away exactly as easily. The rewrite itself is
 *  capped — files written and bytes added — because a replacement pasted into
 *  every match of a broad query can inflate a project far past its quota in
 *  one command.
 */
export async function replaceInProject(
  projectId: string,
  options: ReplaceOptions,
): Promise<ReplaceResult> {
  if (options.replacement.length > MAX_REPLACEMENT_LENGTH) {
    throw new BadRequestError(
      "That replacement is too long",
      "REPLACEMENT_TOO_LONG",
    );
  }
  if (options.search.query.trim().length === 0) {
    return { files: [], replacements: 0, truncated: false };
  }

  const pattern = buildPattern(options.search);

  const input: SearchWorkerInput = {
    root: projectRoot(projectId),
    ignored: [...IGNORED_DIRECTORIES],
    pattern: { source: pattern.source, flags: pattern.flags },
    replacement: options.replacement,
    limits: {
      maxFileBytes: MAX_FILE_BYTES,
      maxMatches: MAX_MATCHES,
      maxFilesScanned: MAX_FILES_SCANNED,
      maxLineLength: MAX_LINE_LENGTH,
      maxFilesWritten: MAX_FILES_WRITTEN,
      maxTotalBytesAdded: MAX_TOTAL_BYTES_ADDED,
    },
  };

  const result = await runInWorker(input, projectId);
  const files: FileReplacement[] = result.files ?? [];

  // Recorded after the fact: the caps above bound the write before it
  // happens, and the accounting still has to land in the quota.
  for (const file of files) {
    recordWrite(projectId, file.bytesAfter, file.bytesBefore);
  }

  return {
    files: files.map(({ relPath, replacements }) => ({ relPath, replacements })),
    replacements: files.reduce((sum, file) => sum + file.replacements, 0),
    truncated: result.truncated,
  };
}

function runInWorker(
  input: SearchWorkerInput,
  projectId: string,
): Promise<SearchWorkerOutput> {
  return new Promise<SearchResult>((resolve, reject) => {
    const worker = new Worker(workerUrl(), { workerData: input });

    // Settled once: a worker that posts a result and then exits would
    // otherwise resolve and then have its exit ignored, and one that is
    // terminated raises both `exit` and a cleared timer.
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      void worker.terminate();
      action();
    };

    const deadline = setTimeout(() => {
      increment("search_timeouts");
      logger.warn("search exceeded its deadline", { projectId });
      finish(() => {
        reject(new SearchTimeoutError());
      });
    }, SEARCH_TIMEOUT_MS);

    // `unref` so a scan in flight never holds the process open during a
    // shutdown that is otherwise ready to go.
    deadline.unref?.();

    worker.on("message", (result: SearchWorkerOutput) => {
      finish(() => {
        resolve(result);
      });
    });

    worker.on("error", (error: Error) => {
      finish(() => {
        reject(error);
      });
    });

    worker.on("exit", (code) => {
      // Only reached when the worker went without saying anything — it posts
      // its result before exiting normally.
      finish(() => {
        reject(new Error(`Search worker stopped unexpectedly (code ${String(code)})`));
      });
    });
  });
}
