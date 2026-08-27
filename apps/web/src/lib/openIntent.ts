/** Whether the next open of a path is a preview.
 *
 *  Opening is a round trip: something emits `readFile`, and the tab appears
 *  when `readFileSuccess` comes back. The intent behind the open — a single
 *  click that is browsing, versus anything deliberate — is known at the
 *  first end and needed at the second, and there is nowhere on the wire to
 *  put it that the server has any business knowing about.
 *
 *  So it is recorded here, against the path, and consumed when the file
 *  lands. A set rather than a flag because two opens can be in flight at
 *  once; consumed on read so that a preview intent cannot leak into a later,
 *  deliberate open of the same file.
 */
const previewing = new Set<string>();

/** Marks the in-flight open of this path as a preview. */
export const markPreviewOpen = (relPath: string): void => {
  previewing.add(relPath);
};

/** Reads and clears the intent recorded for this path. Defaults to a
 *  permanent open, which is the right answer for every caller that never
 *  said otherwise. */
export const takeOpenIntent = (relPath: string): { preview: boolean } => ({
  preview: previewing.delete(relPath),
});

/** Drops every recorded intent. For tests, and for leaving a project. */
export const clearOpenIntents = (): void => {
  previewing.clear();
};
