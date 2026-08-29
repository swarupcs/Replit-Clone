import { useEffect, useRef } from "react";
import type { editor } from "monaco-editor";
import { publishViewport, subscribeCollab, viewportIn } from "../lib/collab.ts";
import { usePresenceStore } from "../store/presenceStore.ts";

/** Riding along with somebody else's scroll position.
 *
 *  Follow mode already opened whichever file the person you follow is in. This
 *  is the other half: staying on the same part of it.
 *
 *  The reason this was not done when following shipped was that awareness had
 *  no viewport in it — and the reason it should not be done unconditionally
 *  still stands, because having the page yanked around by a stranger's
 *  scrolling is motion sickness rather than collaboration. What makes it
 *  right here is that it is scoped to follow mode, which is a button somebody
 *  pressed. Following is a request to be moved. Nobody who has not asked is
 *  moved by this.
 */
export interface ViewportSyncOptions {
  editor: editor.IStandaloneCodeEditor | null;
  relPath: string | undefined;
  /** False for a pane that is not the one being followed, and while the
   *  document is not collaborative. */
  enabled: boolean;
  /** Monaco is created after the first render; this re-runs the effect once
   *  it exists. Same reason as every other effect in the editor. */
  mountTick: number;
}

/** Monaco's smooth scroll. Imported as a literal rather than from
 *  `monaco-editor` so this module stays free of the editor bundle. */
const SMOOTH_SCROLL = 1;

export function useViewportSync({
  editor: codeEditor,
  relPath,
  enabled,
  mountTick,
}: ViewportSyncOptions): void {
  const following = usePresenceStore((state) => state.following);

  /** The line this editor was last scrolled to BY the person it follows.
   *
   *  A followed scroll fires our own scroll handler, which would publish the
   *  new position as though we had chosen it. Harmless in one direction; two
   *  people following each other would push one another back and forth.
   *
   *  Held as the line rather than as a "currently riding" flag, because a flag
   *  has to be cleared on a timer and `setScrollTop` does not promise when its
   *  event arrives — so the flag was either still up when the user's own next
   *  scroll landed, or already down when the ridden one did. Matching the line
   *  needs no timing at all. It is consumed on the first scroll that reaches
   *  it, so scrolling back there deliberately later still publishes. */
  const rodeTo = useRef<number | null>(null);

  // ---- outward: tell anyone following where we are ------------------------
  useEffect(() => {
    if (!codeEditor || !relPath || !enabled) return;

    const publish = () => {
      const ranges = codeEditor.getVisibleRanges();
      const first = ranges[0];
      const last = ranges[ranges.length - 1];
      if (!first || !last) return;

      const top = first.startLineNumber;

      // This is the scroll `ride` caused. Swallowed once, then forgotten.
      if (rodeTo.current === top) {
        rodeTo.current = null;
        return;
      }
      rodeTo.current = null;

      publishViewport(relPath, { top, bottom: last.endLineNumber });
    };

    publish();
    const subscription = codeEditor.onDidScrollChange(publish);

    return () => {
      subscription.dispose();
    };
  }, [codeEditor, relPath, enabled, mountTick]);

  // ---- inward: go where the person we follow is ---------------------------
  useEffect(() => {
    if (!codeEditor || !relPath || !enabled || !following) return;

    const ride = () => {
      const viewport = viewportIn(relPath, following);
      if (!viewport) return;

      const ranges = codeEditor.getVisibleRanges();
      const mine = ranges[0]?.startLineNumber;
      // Already there. Scrolling to where we are is not a no-op in Monaco —
      // it cancels an in-flight smooth scroll — so it has to be checked
      // rather than left to be idempotent.
      if (mine === viewport.top) return;

      rodeTo.current = viewport.top;
      codeEditor.setScrollTop(
        codeEditor.getTopForLineNumber(viewport.top),
        SMOOTH_SCROLL,
      );
    };

    ride();
    // Their viewport arrives as an awareness update, which is what `notify`
    // announces. There is no separate event for it and there should not be:
    // it is presence, and presence is already delivered.
    return subscribeCollab(ride);
  }, [codeEditor, relPath, enabled, following, mountTick]);
}
