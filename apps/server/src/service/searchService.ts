import fs from "node:fs/promises";
import path from "node:path";
import type { SearchMatch, SearchOptions } from "@replit-clone/shared";
import { IGNORED_DIRECTORIES } from "./fileTreeService.js";
import { projectRoot, toRelativePath } from "../utils/projectPaths.js";

/** Search across a project's files.
 *
 *  Quick Open matches filenames only, so there was no way to find a symbol —
 *  the one thing you reach for constantly in a codebase you did not write.
 *
 *  Implemented in Node rather than shelling out to ripgrep: the server may not
 *  have it installed, and passing a user-supplied pattern to a subprocess is a
 *  category of bug worth not having. The bounds below are what keep a plain
 *  scan honest on a large tree.
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

const IGNORED = new Set<string>(IGNORED_DIRECTORIES);

/** Bytes that mean this is not text. Checking a prefix is what every grep does
 *  rather than trying to decode the whole file first. */
function looksBinary(sample: Buffer): boolean {
  for (const byte of sample) if (byte === 0) return true;
  return false;
}

/** Escapes a string so it matches literally inside a RegExp. */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds the matcher, or throws when the user's own regex does not compile. */
function buildPattern(options: SearchOptions): RegExp {
  const source = options.isRegex
    ? options.query
    : escapeLiteral(options.query);

  const body = options.wholeWord ? `\\b(?:${source})\\b` : source;
  const flags = options.caseSensitive ? "g" : "gi";

  return new RegExp(body, flags);
}

export interface SearchResult {
  matches: SearchMatch[];
  /** True when a limit stopped the scan, so the UI can say the list is partial
   *  rather than implying it found everything. */
  truncated: boolean;
}

export async function searchProject(
  projectId: string,
  options: SearchOptions,
): Promise<SearchResult> {
  if (options.query.trim().length === 0) {
    return { matches: [], truncated: false };
  }

  const pattern = buildPattern(options);
  const root = projectRoot(projectId);

  const matches: SearchMatch[] = [];
  let filesScanned = 0;
  let truncated = false;

  async function walk(directory: string): Promise<void> {
    if (truncated) return;

    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );

    for (const entry of entries) {
      if (truncated) return;
      if (IGNORED.has(entry.name)) continue;

      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }

      // Symlinks are listed but never followed — the same rule the file tree
      // applies, and for the same reason.
      if (!entry.isFile()) continue;

      if (++filesScanned > MAX_FILES_SCANNED) {
        truncated = true;
        return;
      }

      await scanFile(absolute);
    }
  }

  async function scanFile(absolute: string): Promise<void> {
    const stats = await fs.stat(absolute).catch(() => undefined);
    if (!stats || stats.size > MAX_FILE_BYTES) return;

    const contents = await fs.readFile(absolute).catch(() => undefined);
    if (!contents || looksBinary(contents.subarray(0, 8000))) return;

    const relPath = toRelativePath(projectId, absolute);
    const lines = contents.toString("utf8").split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";

      // `lastIndex` is shared state on a global regex; reset it per line or
      // matches are silently skipped.
      pattern.lastIndex = 0;
      if (!pattern.test(line)) continue;

      matches.push({
        relPath,
        line: index + 1,
        // Trimmed for transport, not for matching: a minified line would
        // otherwise be sent in full for a single hit.
        preview: line.slice(0, MAX_LINE_LENGTH),
        column: line.search(pattern) + 1,
      });

      if (matches.length >= MAX_MATCHES) {
        truncated = true;
        return;
      }
    }
  }

  await walk(root);

  return { matches, truncated };
}
