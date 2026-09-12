/** What kind of thing is holding the screen. plan.md §13.10.
 *
 *  `useMediaQuery("(max-width: 900px)")` was the whole of the mobile story: one
 *  breakpoint that collapses the layout. It is a good breakpoint and it answers
 *  a different question from the one this row asks. **Width says how much room
 *  there is. It does not say whether there is a mouse.**
 *
 *  The two come apart in both directions, and both are ordinary:
 *
 *  - A tablet at 1024px is wide enough for the panes and has no pointer at all,
 *    so it gets mouse-sized hit targets and no terminal key bar.
 *  - A desktop window dragged to 800px is narrow and still has a mouse, so it
 *    used to get a layout built for fingers it does not have.
 *
 *  So touch affordances key off `(pointer: coarse)` — a capability the browser
 *  actually knows — and layout keeps keying off width, which is the thing width
 *  is good for. Kept as pure functions over the query results so the decisions
 *  are testable without a DOM.
 */

export type LayoutWidth = "narrow" | "wide";

export interface DeviceCapabilities {
  /** `(max-width: 900px)` — the existing breakpoint, unchanged. */
  narrow: boolean;
  /** `(pointer: coarse)` — a finger or a stylus rather than a mouse. */
  coarsePointer: boolean;
}

/** Media queries as strings, in one place, so the component and the test agree
 *  on what is being asked. */
export const NARROW_QUERY = "(max-width: 900px)";
export const COARSE_POINTER_QUERY = "(pointer: coarse)";

export function layoutWidth(capabilities: DeviceCapabilities): LayoutWidth {
  return capabilities.narrow ? "narrow" : "wide";
}

/** Whether to offer the terminal's key bar.
 *
 *  Pointer, not width: the bar exists because a SOFTWARE KEYBOARD has no
 *  `Ctrl`, and a software keyboard is what a coarse pointer implies. A narrow
 *  desktop window has a real keyboard with a real Ctrl on it, and a bar of
 *  fake modifier keys there is clutter in front of a terminal.
 */
export function wantsTerminalKeys(capabilities: DeviceCapabilities): boolean {
  return capabilities.coarsePointer;
}

/** The minimum comfortable hit target, in pixels.
 *
 *  24 is fine for a mouse, which lands where it was pointed. A fingertip
 *  covers about 9mm and lands approximately, which is where the familiar 44
 *  comes from. Applied to the file tree and the tab strip — the two surfaces
 *  §13.10 names as "built for a mouse".
 */
export function hitTargetPx(capabilities: DeviceCapabilities): number {
  return capabilities.coarsePointer ? 44 : 24;
}

/** Whether Monaco should be told it is being touched.
 *
 *  Its own defaults assume a mouse: drag-to-select from a hover, a context
 *  menu on right-click, a cursor that blinks under a caret nobody can see past
 *  their thumb. This does not try to make Monaco a mobile editor — §13.10 says
 *  plainly that the row may have no user — it turns off the handful of things
 *  that are actively wrong without one.
 */
export interface TouchEditorOptions {
  /** The mouse-hover popup, which on touch fires on tap and covers the line
   *  that was tapped. */
  hover: { enabled: boolean };
  /** The overview ruler and minimap are a mouse's scrollbar. */
  minimap: { enabled: boolean };
  /** Bigger by default: the default is sized for reading at a desk. */
  fontSize: number;
  /** Touch scrolling should move the buffer, not select text. */
  dragAndDrop: boolean;
}

export function touchEditorOptions(
  capabilities: DeviceCapabilities,
  baseFontSize: number,
): TouchEditorOptions | null {
  // Null rather than a no-op object: the caller spreads this only when there
  // is something to say, so a mouse user's settings are untouched rather than
  // being overwritten with the same values.
  if (!capabilities.coarsePointer) return null;

  return {
    hover: { enabled: false },
    minimap: { enabled: false },
    // One step up, not a redesign. Somebody who has chosen a size has chosen
    // it; this nudges rather than overrides.
    fontSize: Math.max(baseFontSize, 15),
    dragAndDrop: false,
  };
}
