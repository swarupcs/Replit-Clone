/** Leaves the app for another origin.
 *
 *  A one-line module so it can be replaced in a test — `window.location` is not
 *  reliably redefinable in jsdom — and so the decision has somewhere to live:
 *
 *  A full navigation rather than a popup. An OAuth consent screen is a
 *  top-level page; opening one in a popup means a blocked popup leaves the user
 *  looking at a button that did nothing, with no way to tell why.
 */
export function navigateAway(url: string): void {
  window.location.href = url;
}
