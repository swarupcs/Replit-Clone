import { create } from "zustand";
import type { PaneId } from "./openTabsStore.ts";

/** What an editor pane reports about the file it is showing.
 *
 *  The status bar used to be rendered by `EditorComponent` itself, which had
 *  two consequences: opening the split pane produced *two* status bars, and
 *  closing every tab took the bar away entirely — the component returns its
 *  empty state before it ever reaches the bar.
 *
 *  So the panes publish their state here and the bar is rendered once, by the
 *  playground, outside them.
 */
export interface EditorStatus {
  relPath: string;
  line: number;
  column: number;
  /** Characters selected, 0 when the selection is empty. */
  selectionCount: number;
  /** Undefined for an extension the mapper does not know, which the bar then
   *  says nothing about rather than guessing. */
  language: string | undefined;
  tabSize: number;
  isDirty: boolean;
  /** Why the last write was refused, if it was. */
  writeError: string | null;
  canEdit: boolean;
  /** Whether the file is a live shared document, which the server saves. */
  shared: boolean;
}

interface EditorStatusStore {
  /** One entry per pane that currently has a file open. */
  byPane: Partial<Record<PaneId, EditorStatus>>;

  publish: (pane: PaneId, status: EditorStatus) => void;
  /** Called when a pane has no file, or goes away. */
  clear: (pane: PaneId) => void;
}

/** True when nothing a reader would notice has changed. The cursor moves on
 *  every keystroke, and a new object per keystroke would re-render the bar
 *  whether or not anything in it differs. */
function same(a: EditorStatus | undefined, b: EditorStatus): boolean {
  if (!a) return false;
  return (
    a.relPath === b.relPath &&
    a.line === b.line &&
    a.column === b.column &&
    a.selectionCount === b.selectionCount &&
    a.language === b.language &&
    a.tabSize === b.tabSize &&
    a.isDirty === b.isDirty &&
    a.writeError === b.writeError &&
    a.canEdit === b.canEdit &&
    a.shared === b.shared
  );
}

export const useEditorStatusStore = create<EditorStatusStore>((set) => ({
  byPane: {},

  publish: (pane, status) =>
    set((state) =>
      same(state.byPane[pane], status)
        ? state
        : { byPane: { ...state.byPane, [pane]: status } },
    ),

  clear: (pane) =>
    set((state) => {
      if (!state.byPane[pane]) return state;
      const next = { ...state.byPane };
      delete next[pane];
      return { byPane: next };
    }),
}));

/** What the bar should show: the focused pane's file, falling back to the other
 *  one so closing the focused pane's last tab does not blank the bar while the
 *  split still has a file open. */
export const selectVisibleStatus =
  (focused: PaneId) =>
  (state: EditorStatusStore): EditorStatus | undefined =>
    state.byPane[focused] ??
    state.byPane[focused === "primary" ? "secondary" : "primary"];
