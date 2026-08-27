import { parseUnifiedDiff } from "../utils/parseUnifiedDiff.ts";

/** What happened to a run of lines, in the terms a gutter can draw.
 *
 *  Three states rather than the diff's two, because a gutter is drawn against
 *  the file as it is now and a deletion has no line there to mark. A run of
 *  removals with additions beside it is a modification; a run with nothing
 *  beside it is a deletion, and it gets a marker at the seam rather than a
 *  bar over lines that are not there.
 */
export type GutterKind = "added" | "modified" | "removed";

export interface GutterRegion {
  kind: GutterKind;
  /** 1-based, inclusive, in the file as it currently stands.
   *
   *  For a deletion both ends are the line the removed text sat above, so the
   *  marker lands at the seam. */
  startLine: number;
  endLine: number;
}

/** Turns a unified diff of one file into the bars drawn down its margin.
 *
 *  VS Code's is the most visible git feature this editor did not have, and
 *  the data was already here: `gitService.diff` produces the patch and
 *  `parseUnifiedDiff` already resolves both files' line numbers. What was
 *  missing is only the reduction from lines to runs.
 */
export function gutterRegions(patch: string): GutterRegion[] {
  const { hunks, binary } = parseUnifiedDiff(patch);
  if (binary) return [];

  const regions: GutterRegion[] = [];

  for (const hunk of hunks) {
    // A run is a maximal stretch of consecutive changed lines. Additions and
    // removals inside one run are the same edit seen from two sides, which is
    // why they collapse to "modified" rather than reading as one of each.
    let added: number[] = [];
    let removed = 0;
    /** The last line number in the new file that actually exists, so a
     *  deletion at the end of a run knows where to put its marker. */
    let lastNewLine = 0;

    const flush = () => {
      if (added.length === 0 && removed === 0) return;

      if (added.length === 0) {
        // Pure deletion: nothing remains to draw a bar over. The marker goes
        // on the line the removed text sat above — or line 1 when the file
        // began with the deletion and there is no line above it.
        const at = Math.max(1, lastNewLine);
        regions.push({ kind: "removed", startLine: at, endLine: at });
      } else {
        regions.push({
          kind: removed === 0 ? "added" : "modified",
          startLine: added[0] ?? 1,
          endLine: added[added.length - 1] ?? 1,
        });
      }

      added = [];
      removed = 0;
    };

    for (const line of hunk.lines) {
      if (line.kind === "meta") continue;

      if (line.kind === "add") {
        if (line.newLine !== undefined) {
          added.push(line.newLine);
          lastNewLine = line.newLine;
        }
        continue;
      }

      if (line.kind === "remove") {
        removed += 1;
        continue;
      }

      // A context line ends whatever run was open.
      flush();
      if (line.newLine !== undefined) lastNewLine = line.newLine;
    }

    flush();
  }

  return regions;
}
