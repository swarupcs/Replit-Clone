/** What a key press means in the file tree.
 *
 *  Pure, and separate from the component, for the same reason the diff parser
 *  is: the interesting part is a set of rules about what Left means on a
 *  collapsed folder versus an expanded one, and that is worth testing without
 *  a DOM, a store, or a socket in the way.
 *
 *  The rules are the WAI-ARIA tree pattern, which is also what every editor
 *  has trained people to expect.
 */

/** The row the key was pressed on. `isExpanded` is meaningless for a file and
 *  is ignored for one. */
export interface TreeKeyContext {
  key: string;
  /** The focused row's path. */
  from: string;
  kind: "file" | "directory";
  isExpanded: boolean;
  /** Rows top to bottom as they appear on screen — a collapsed folder's
   *  children are not in it, which is what makes "the next row" the right
   *  answer for Down and for stepping into a folder. */
  visibleOrder: string[];
}

export type TreeKeyAction =
  /** Move the keyboard to another row, changing nothing else. */
  | { kind: "focus"; relPath: string }
  | { kind: "expand"; relPath: string }
  | { kind: "collapse"; relPath: string }
  /** Enter/Space: open a file, or toggle a folder — the same thing a click
   *  does, so the two cannot drift apart. */
  | { kind: "activate"; relPath: string }
  | null;

/** The folder containing `relPath`, or "" at the top level. */
function parentOf(relPath: string): string {
  return relPath.split("/").slice(0, -1).join("/");
}

export function treeKeyAction({
  key,
  from,
  kind,
  isExpanded,
  visibleOrder,
}: TreeKeyContext): TreeKeyAction {
  const index = visibleOrder.indexOf(from);
  // A focused row that is not on screen means the two have gone out of step;
  // moving relative to it would land somewhere arbitrary.
  if (index === -1) return null;

  const isFolder = kind === "directory";

  switch (key) {
    case "ArrowDown": {
      const next = visibleOrder[index + 1];
      // Clamped rather than wrapped: wrapping past the last file to the first
      // is disorienting in a pane you are scanning downwards.
      return next === undefined ? null : { kind: "focus", relPath: next };
    }

    case "ArrowUp": {
      const previous = visibleOrder[index - 1];
      return previous === undefined
        ? null
        : { kind: "focus", relPath: previous };
    }

    case "Home": {
      const first = visibleOrder[0];
      return first === undefined || first === from
        ? null
        : { kind: "focus", relPath: first };
    }

    case "End": {
      const last = visibleOrder[visibleOrder.length - 1];
      return last === undefined || last === from
        ? null
        : { kind: "focus", relPath: last };
    }

    case "ArrowRight": {
      if (!isFolder) return null;
      if (!isExpanded) return { kind: "expand", relPath: from };

      // Already open: step into it. The first child is the next visible row by
      // construction — an expanded folder's children follow it immediately.
      const child = visibleOrder[index + 1];
      return child === undefined ? null : { kind: "focus", relPath: child };
    }

    case "ArrowLeft": {
      if (isFolder && isExpanded) return { kind: "collapse", relPath: from };

      // Otherwise go out to the folder this row lives in. A top-level row has
      // no parent row to go to — the project root has no row of its own.
      const parent = parentOf(from);
      if (parent === "" || !visibleOrder.includes(parent)) return null;
      return { kind: "focus", relPath: parent };
    }

    case "Enter":
    case " ":
      return { kind: "activate", relPath: from };

    default:
      return null;
  }
}
