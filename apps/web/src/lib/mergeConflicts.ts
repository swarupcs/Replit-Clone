/** One conflict block in a file git could not merge.
 *
 *  Line numbers are 1-based and inclusive, matching Monaco's, because every
 *  consumer of this ends up handing them to a decoration or a range.
 */
export interface ConflictBlock {
  /** The `<<<<<<<` line. */
  startLine: number;
  /** The `=======` line. */
  separatorLine: number;
  /** The `>>>>>>>` line. */
  endLine: number;
  /** What the labels say, for the buttons: "HEAD", "feature/x". */
  currentLabel: string;
  incomingLabel: string;
  currentLines: string[];
  incomingLines: string[];
}

const START = /^<{7}\s?(.*)$/;
const SEPARATOR = /^={7}\s*$/;
const END = /^>{7}\s?(.*)$/;

/** Finds the conflict blocks in a file.
 *
 *  A state the product can already reach — pull produces conflicts — and had
 *  no answer for beyond showing the raw markers. Written as a scanner rather
 *  than a regex over the whole file: markers can appear inside a string
 *  literal or a fenced code block in a README, and a state machine that only
 *  accepts a well-formed start/separator/end sequence rejects those instead
 *  of pairing a real marker with a decorative one.
 */
export function findConflicts(text: string): ConflictBlock[] {
  const lines = text.split("\n");
  const blocks: ConflictBlock[] = [];

  let start = -1;
  let separator = -1;
  let currentLabel = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    const startMatch = START.exec(line);
    if (startMatch) {
      // A second start before the first closed means the file is not in a
      // shape this can reason about; the later one wins, which matches how
      // git itself would have written it.
      start = index;
      separator = -1;
      currentLabel = (startMatch[1] ?? "").trim();
      continue;
    }

    if (start === -1) continue;

    if (SEPARATOR.test(line)) {
      separator = index;
      continue;
    }

    const endMatch = END.exec(line);
    if (endMatch && separator !== -1) {
      blocks.push({
        startLine: start + 1,
        separatorLine: separator + 1,
        endLine: index + 1,
        currentLabel: currentLabel || "Current",
        incomingLabel: (endMatch[1] ?? "").trim() || "Incoming",
        currentLines: lines.slice(start + 1, separator),
        incomingLines: lines.slice(separator + 1, index),
      });
      start = -1;
      separator = -1;
    }
  }

  return blocks;
}

export type Resolution = "current" | "incoming" | "both";

/** Replaces one conflict block with the chosen side.
 *
 *  Returns the whole file rather than a patch: the editor holds the buffer,
 *  and handing it a new string is one operation it can undo, where a series
 *  of range edits is several.
 */
export function resolveConflict(
  text: string,
  block: ConflictBlock,
  resolution: Resolution,
): string {
  const lines = text.split("\n");

  const kept =
    resolution === "current"
      ? block.currentLines
      : resolution === "incoming"
        ? block.incomingLines
        : [...block.currentLines, ...block.incomingLines];

  return [
    ...lines.slice(0, block.startLine - 1),
    ...kept,
    ...lines.slice(block.endLine),
  ].join("\n");
}

/** True while any marker remains, so the UI can say the file is still
 *  conflicted rather than letting a half-resolved file look finished. */
export function hasConflicts(text: string): boolean {
  return findConflicts(text).length > 0;
}
