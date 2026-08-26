import { useSyncExternalStore } from "react";

/** Whether a CSS media query currently matches.
 *
 *  `useSyncExternalStore` rather than an effect with `useState`: the query has
 *  an answer before the first paint, and reading it in an effect renders the
 *  wide layout once and then throws it away — which on the playground means
 *  mounting the editor, the terminal and the preview into a layout that is
 *  about to change.
 *
 *  A layout branch, not a device test. The app cannot know what a device is;
 *  it can know that four panes do not fit across 780 pixels.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      // Guarded: jsdom has `matchMedia` only when a test installs it, and a
      // component that throws here fails for a reason that has nothing to do
      // with what it was being tested for.
      const list = window.matchMedia?.(query);
      if (!list) return () => undefined;

      list.addEventListener("change", onChange);
      return () => {
        list.removeEventListener("change", onChange);
      };
    },
    () => window.matchMedia?.(query).matches ?? false,
    // On the server there is no viewport; the wide layout is the one the app
    // is designed around, so it is the safer guess.
    () => false,
  );
}
