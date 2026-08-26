import { create } from "zustand";

/** Which rows in the file tree are selected.
 *
 *  The tree acted on exactly one entry at a time, so deleting or moving a
 *  handful of files meant repeating the same gesture once per file. Selection
 *  lives outside the tree components because a range needs the flattened order
 *  of what is currently visible, which only the tree knows and only it can
 *  keep up to date.
 */
interface TreeSelectionStore {
  selected: Set<string>;
  /** Where a shift-click measures its range from — the last row clicked
   *  without shift. */
  anchor: string | null;
  /** Rows in the order they appear on screen, so a range means what the user
   *  sees rather than what the tree's recursion happens to visit. */
  visibleOrder: string[];
  /** The row the keyboard is on, which is a different thing from the selection
   *  and from the open file: it is where the next arrow key moves from.
   *
   *  Held here rather than in the DOM because it is what makes the tree a
   *  single tab stop — exactly one row carries `tabIndex=0`, and tabbing back
   *  into the tree returns to the row the user left rather than to the top. */
  focused: string | null;

  setVisibleOrder: (paths: string[]) => void;
  setFocused: (relPath: string | null) => void;
  /** Applies a click, honouring the modifier keys the way file managers do. */
  click: (relPath: string, modifiers: { meta: boolean; shift: boolean }) => void;
  /** Selects exactly this row, e.g. when a right-click lands outside the
   *  current selection. */
  selectOnly: (relPath: string) => void;
  clear: () => void;
  isSelected: (relPath: string) => boolean;
}

export const useTreeSelectionStore = create<TreeSelectionStore>((set, get) => ({
  selected: new Set<string>(),
  anchor: null,
  visibleOrder: [],
  focused: null,

  setVisibleOrder: (paths) =>
    set((state) => {
      // The tree recomputes this array on every render; storing an identical
      // one would still change its identity and wake every subscriber.
      if (
        state.visibleOrder.length === paths.length &&
        state.visibleOrder.every((path, index) => path === paths[index])
      ) {
        return state;
      }

      // Collapsing a folder, filtering, or a refetch can take the focused row
      // off screen. Left dangling it would be the tab stop for a row that no
      // longer exists, and the tree would have none at all.
      const keepFocus =
        state.focused !== null && paths.includes(state.focused)
          ? state.focused
          : null;

      return { visibleOrder: paths, focused: keepFocus };
    }),

  setFocused: (relPath) =>
    set((state) => (state.focused === relPath ? state : { focused: relPath })),

  click: (relPath, { meta, shift }) =>
    set((state) => {
      // Shift extends from the anchor. Without an anchor there is nothing to
      // extend from, so it behaves like a plain click.
      if (shift && state.anchor) {
        const from = state.visibleOrder.indexOf(state.anchor);
        const to = state.visibleOrder.indexOf(relPath);

        if (from !== -1 && to !== -1) {
          const [start, end] = from < to ? [from, to] : [to, from];
          return {
            selected: new Set(state.visibleOrder.slice(start, end + 1)),
            // The anchor stays put, so extending again re-measures from the
            // same place rather than walking away from it.
            anchor: state.anchor,
          };
        }
      }

      if (meta) {
        const next = new Set(state.selected);
        if (next.has(relPath)) next.delete(relPath);
        else next.add(relPath);
        return { selected: next, anchor: relPath };
      }

      return { selected: new Set([relPath]), anchor: relPath };
    }),

  selectOnly: (relPath) =>
    set({ selected: new Set([relPath]), anchor: relPath }),

  clear: () => set({ selected: new Set<string>(), anchor: null }),

  isSelected: (relPath) => get().selected.has(relPath),
}));

/** The selection in on-screen order, which is the order operations should be
 *  applied in. */
export const selectOrderedSelection = (state: TreeSelectionStore): string[] =>
  state.visibleOrder.filter((relPath) => state.selected.has(relPath));
