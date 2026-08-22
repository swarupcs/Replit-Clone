import fs from "node:fs/promises";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

/** The project scan, run off the main thread.
 *
 *  It lives in a worker for one reason: a regular expression the user supplied
 *  can take unbounded time to match a single line, and there is no way to
 *  interrupt one. `(a+)+$` against forty characters does not finish in any
 *  time worth waiting for. Run on the main thread — which is where this used
 *  to be — that is not a slow search, it is the whole server stopped: no other
 *  project, no terminal, no health check, until the process is killed.
 *
 *  A worker can be terminated. `searchService` gives this one a deadline and
 *  takes it away when it runs out.
 *
 *  Deliberately imports nothing from the rest of the server: everything it
 *  needs arrives in `workerData`, so starting one does not drag a Prisma
 *  client and a config parser into a second thread.
 */

export interface SearchWorkerInput {
  /** Absolute path of the project root. Resolved by the caller, which is the
   *  only place that knows how to confine one. */
  root: string;
  /** Directory names never descended into. */
  ignored: string[];
  pattern: { source: string; flags: string };
  /** When present, every match is replaced with this text (JavaScript
   *  replacement patterns like $1 apply) and the file is written back.
   *  Absent means search-only: nothing is written. */
  replacement?: string;
  limits: {
    maxFileBytes: number;
    maxMatches: number;
    maxFilesScanned: number;
    maxLineLength: number;
    /** Replace mode only: how many files may be rewritten. */
    maxFilesWritten?: number;
    /** Replace mode only: total bytes that may be added across all rewrites.
     *  Shrinking never counts against it. */
    maxTotalBytesAdded?: number;
  };
}

/** One file the rewrite touched. */
export interface FileReplacement {
  relPath: string;
  replacements: number;
  /** Size before and after, so quota accounting can apply its
   *  `- replacing + incoming` arithmetic without re-statting the tree. */
  bytesBefore: number;
  bytesAfter: number;
}

export interface SearchWorkerOutput {
  matches: { relPath: string; line: number; column: number; preview: string }[];
  truncated: boolean;
  /** Present in replace mode: the files that were rewritten. */
  files?: FileReplacement[];
}

/** Bytes that mean this is not text. Checking a prefix is what every grep does
 *  rather than trying to decode the whole file first. */
function looksBinary(sample: Buffer): boolean {
  for (const byte of sample) if (byte === 0) return true;
  return false;
}

async function run(input: SearchWorkerInput): Promise<SearchWorkerOutput> {
  const { root, limits } = input;
  const ignored = new Set(input.ignored);
  const pattern = new RegExp(input.pattern.source, input.pattern.flags);

  const matches: SearchWorkerOutput["matches"] = [];
  const files: FileReplacement[] = [];
  let filesScanned = 0;
  let truncated = false;
  let bytesAddedTotal = 0;

  function toRelative(absolute: string): string {
    return path.relative(root, absolute).split(path.sep).join("/");
  }

  /** Rewrite mode: one pass over the whole file, then one write. */
  async function replaceInFile(
    absolute: string,
    contents: Buffer,
  ): Promise<void> {
    const text = contents.toString("utf8");

    // Two passes on purpose: `match` counts, then `replace` expands the
    // replacement patterns. A counting callback would have to re-implement
    // that expansion to return the same string.
    pattern.lastIndex = 0;
    const found = text.match(pattern);
    if (!found || found.length === 0) return;

    const updated = text.replace(pattern, input.replacement ?? "");
    if (updated === text) return;

    const bytesAfter = Buffer.byteLength(updated, "utf8");
    const bytesAdded = bytesAfter - contents.byteLength;

    if (
      files.length >= (limits.maxFilesWritten ?? limits.maxMatches) ||
      bytesAddedTotal + Math.max(bytesAdded, 0) >
        (limits.maxTotalBytesAdded ?? Number.MAX_SAFE_INTEGER)
    ) {
      truncated = true;
      return;
    }

    await fs.writeFile(absolute, updated, "utf8");
    files.push({
      relPath: toRelative(absolute),
      replacements: found.length,
      bytesBefore: contents.byteLength,
      bytesAfter,
    });
    bytesAddedTotal += Math.max(bytesAdded, 0);
  }

  async function scanFile(absolute: string): Promise<void> {
    const stats = await fs.stat(absolute).catch(() => undefined);
    if (!stats || stats.size > limits.maxFileBytes) return;

    const contents = await fs.readFile(absolute).catch(() => undefined);
    if (!contents || looksBinary(contents.subarray(0, 8000))) return;

    if (input.replacement !== undefined) {
      await replaceInFile(absolute, contents);
      return;
    }

    const relPath = toRelative(absolute);
    const lines = contents.toString("utf8").split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";

      // `lastIndex` is shared state on a global regex; reset it per line or
      // matches are silently skipped.
      pattern.lastIndex = 0;
      const found = pattern.exec(line);
      if (!found) continue;

      matches.push({
        relPath,
        line: index + 1,
        // Taken from the match already in hand. Calling `line.search` for it
        // ran the same expression a second time, doubling the cost of exactly
        // the pattern this file exists to survive.
        column: found.index + 1,
        // Trimmed for transport, not for matching: a minified line would
        // otherwise be sent in full for a single hit.
        preview: line.slice(0, limits.maxLineLength),
      });

      if (matches.length >= limits.maxMatches) {
        truncated = true;
        return;
      }
    }
  }

  async function walk(directory: string): Promise<void> {
    if (truncated) return;

    const entries = await fs
      .readdir(directory, { withFileTypes: true })
      .catch(() => []);

    for (const entry of entries) {
      if (truncated) return;
      if (ignored.has(entry.name)) continue;

      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }

      // Symlinks are listed but never followed — the same rule the file tree
      // applies, and for the same reason.
      if (!entry.isFile()) continue;

      if (++filesScanned > limits.maxFilesScanned) {
        truncated = true;
        return;
      }

      await scanFile(absolute);
    }
  }

  await walk(root);

  return { matches, truncated, files: input.replacement === undefined ? undefined : files };
}

// `parentPort` is null when this module is imported rather than spawned, which
// is how its pieces stay unit-testable.
if (parentPort) {
  const port = parentPort;

  run(workerData as SearchWorkerInput)
    .then((result) => {
      port.postMessage(result);
    })
    .catch((error: unknown) => {
      // Rethrown on the worker so the parent's `error` handler sees it, rather
      // than the parent waiting out its whole deadline for a message that is
      // never coming.
      throw error instanceof Error ? error : new Error(String(error));
    });
}
