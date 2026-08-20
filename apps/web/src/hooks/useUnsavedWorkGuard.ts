import { useEffect } from "react";
import { useOpenTabsStore, selectHasUnsavedWork } from "../store/openTabsStore.ts";

/** Warns before a reload or a closed tab discards unsaved edits.
 *
 *  Writes are debounced, so there is always a window in which what is on
 *  screen is not yet on disk. Nothing used to cover it: closing the browser
 *  tab or hitting reload dropped those edits with no prompt and no recovery.
 *
 *  The listener is only attached while something is actually dirty — a
 *  permanently registered `beforeunload` blocks the browser's back/forward
 *  cache and slows every navigation away from the app.
 */
export function useUnsavedWorkGuard(): void {
  const hasUnsavedWork = useOpenTabsStore(selectHasUnsavedWork);

  useEffect(() => {
    if (!hasUnsavedWork) return;

    function warn(event: BeforeUnloadEvent) {
      // Browsers show their own wording and ignore anything custom; calling
      // preventDefault is what actually triggers the prompt.
      event.preventDefault();
    }

    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsavedWork]);
}
