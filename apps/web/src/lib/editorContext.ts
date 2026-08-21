import type { AiEditorContext } from "@replit-clone/shared";
import type { PaneId } from "../store/openTabsStore.ts";
import { useOpenTabsStore } from "../store/openTabsStore.ts";

/** A read-only window onto whatever the editor is showing right now.
 *
 *  The assistant needs the LIVE buffer and the LIVE selection, and neither is
 *  in the tab store: `OpenTab.value` is only the value Monaco was seeded with,
 *  so anything typed since a save would be missing, and selection is not
 *  tracked there at all. Rather than mirroring editor state into the store on
 *  every keystroke — which is a lot of renders to serve one panel — each pane
 *  registers a reader here and the panel pulls once, at the moment a question
 *  is asked.
 */

export type EditorContextReader = () => AiEditorContext | undefined;

const readers = new Map<PaneId, EditorContextReader>();

/** Registers a pane's reader. Returns the matching deregister. */
export function registerPaneEditor(
  pane: PaneId,
  reader: EditorContextReader,
): () => void {
  readers.set(pane, reader);

  return () => {
    // Guarded so a pane that has already been replaced by a remount does not
    // delete its successor's reader.
    if (readers.get(pane) === reader) readers.delete(pane);
  };
}

/** What the user is looking at, from the focused pane.
 *
 *  Falls back to the other pane so a split with focus on an empty side still
 *  reports something useful rather than nothing.
 */
export function currentEditorContext(): AiEditorContext | undefined {
  const { focusedPane } = useOpenTabsStore.getState();
  const order: PaneId[] =
    focusedPane === "secondary" ? ["secondary", "primary"] : ["primary", "secondary"];

  for (const pane of order) {
    const context = readers.get(pane)?.();
    if (context?.relPath) return context;
  }

  return undefined;
}

/** Only for tests: drops every registration. */
export function resetPaneEditors(): void {
  readers.clear();
}
