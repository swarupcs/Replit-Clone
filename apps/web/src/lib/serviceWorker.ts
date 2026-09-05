/** Registers the app-shell service worker. plan.md §11.7.
 *
 *  Deliberately narrow. This does not prompt to install, does not ask to show
 *  notifications, and does not tell anybody a new version is ready — a
 *  navigation is network-first, so the next full load already picks one up.
 *  All it buys is that a returning visit on a dead connection gets the editor
 *  shell and a legible offline state instead of the browser's error page.
 */

/** Where the worker is served from, and therefore its scope. Root, because the
 *  shell has to answer for every route in a single-page app. */
const SCRIPT = "/sw.js";

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;

  // Off in development. Vite serves modules unbundled and rewrites them on
  // every edit, and a worker caching those is a morning spent wondering why a
  // change will not appear.
  if (import.meta.env.DEV) return;

  // Never inside an embed. That page is somebody else's iframe on somebody
  // else's site; registering a worker for this origin from it would be a
  // surprising side effect of embedding a read-only view.
  if (window.location.pathname.startsWith("/embed/")) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register(SCRIPT).catch((error: unknown) => {
      // A registration failure is not worth a user-facing message: everything
      // works exactly as it did before this file existed.
      console.warn("service worker registration failed", error);
    });
  });
}

/** Removes any worker this origin has registered, and empties its caches.
 *
 *  Here because a service worker is the one thing in a web app that outlives
 *  the code that installed it: a bad one keeps serving a broken shell to
 *  everybody who has ever visited, and "clear your site data" is not an
 *  instruction to give people. Exported so there is a way out that does not
 *  require one.
 */
export async function unregisterServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;

  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));

  if ("caches" in window) {
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name)));
  }
}
