/** Parsing for `git diff --no-color` output.
 *
 *  Kept apart from the component that draws it because the parsing is the part
 *  worth testing, and it needs neither React nor a container to exercise --
 *  the same split `gitService.parseStatus` makes on the server.
 */

export type DiffLineKind = "add" | "remove" | "context" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  /** Text without the leading +/-/space marker. */
  text: string;
  /** Line number in the old file, absent for an addition. */
  oldLine?: number;
  /** Line number in the new file, absent for a deletion. */
  newLine?: number;
}

export interface DiffHunk {
  /** The `@@ ... @@` line, kept verbatim for the hunk header. */
  header: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  /** True when git said the file is binary, which has no hunks to show. */
  binary: boolean;
  additions: number;
  deletions: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Turns a unified diff into hunks with both files' line numbers resolved.
 *
 *  Everything before the first `@@` is header noise (`diff --git`, `index`,
 *  `---`, `+++`) and is dropped: the panel already knows which file this is,
 *  and repeating the path twice above every diff is only clutter.
 *
 *  A "\ No newline at end of file" marker is kept as a meta line rather than
 *  counted as a change -- it describes the line above it, and colouring it as
 *  an addition would overstate the diff by one line.
 */
export function parseUnifiedDiff(patch: string): ParsedDiff {
  const result: ParsedDiff = {
    hunks: [],
    binary: false,
    additions: 0,
    deletions: 0,
  };

  if (!patch.trim()) return result;

  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  // A trailing newline would otherwise produce a final empty line that renders
  // as a blank row of context.
  const lines = patch.replace(/\n$/, "").split("\n");

  for (const line of lines) {
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      result.binary = true;
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      hunk = { header: line, lines: [] };
      result.hunks.push(hunk);
      continue;
    }

    // Header noise before the first hunk.
    if (!hunk) continue;

    if (line.startsWith("\\")) {
      hunk.lines.push({ kind: "meta", text: line.slice(1).trim() });
      continue;
    }

    const marker = line[0];
    const text = line.slice(1);

    if (marker === "+") {
      hunk.lines.push({ kind: "add", text, newLine });
      newLine += 1;
      result.additions += 1;
    } else if (marker === "-") {
      hunk.lines.push({ kind: "remove", text, oldLine });
      oldLine += 1;
      result.deletions += 1;
    } else {
      // A context line, or an empty one -- git writes those as a bare newline
      // with no leading space, so `text` is "" and both counters still move.
      hunk.lines.push({ kind: "context", text, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  return result;
}
