/** When the editor may replace a buffer with the server's copy of a file.
 *
 *  A tab carries `value`, which is what the SERVER last sent — set when the
 *  file is read and never updated afterwards. It is a snapshot, not a mirror
 *  of what is being typed, and the difference is where the bug lived: the
 *  editor treated any disagreement between the model and that snapshot as
 *  "the server has newer contents" and overwrote the buffer with it.
 *
 *  The effect that did this re-runs whenever the tab object changes, and
 *  clearing the unsaved marker after a successful save is one such change. So
 *  saving re-entered the check with a snapshot from when the file was opened
 *  and put it back over what had just been saved — a line typed and saved
 *  vanished, and on a shared file the reversion reached the server too,
 *  because the model is bound to the shared document.
 */
export interface ReseedInput {
  /** The tab `value` this buffer was last taken from, if any. */
  seeded: string | undefined;
  /** The tab's current server snapshot. */
  tabValue: string;
  /** What the editor is showing now. */
  modelValue: string;
  /** Whether the tab has edits that have not been saved. */
  isDirty: boolean;
  /** Whether the file is being edited collaboratively. */
  isShared: boolean;
}

export function shouldReseedFromServer({
  seeded,
  tabValue,
  modelValue,
  isDirty,
  isShared,
}: ReseedInput): boolean {
  // Nothing new has arrived. The snapshot is the same one this buffer was
  // seeded from, so any difference is the user's own typing.
  if (seeded === tabValue) return false;

  // The shared document is the source of truth for these, and the snapshot may
  // already be behind it.
  if (isShared) return false;

  // Unsaved local edits outrank a reopen.
  if (isDirty) return false;

  return modelValue !== tabValue;
}
