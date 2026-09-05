/** The app shell, cached so a dead connection degrades instead of failing.
 *
 *  plan.md §11.7. A cloud editor gets used on trains and hotel wifi, and until
 *  this existed a dropped connection meant the browser's own error page — not
 *  a degraded editor, not a message, nothing that said what had happened.
 *
 *  **Hand-written rather than generated.** A build-time precache manifest
 *  (`vite-plugin-pwa` and friends) buys a first-visit-offline guarantee this
 *  product cannot use anyway: the first visit has to reach the server to sign
 *  in. What is actually wanted is that a RETURNING visit survives, and a
 *  runtime cache does that in sixty lines with no dependency and no build
 *  step to keep in sync.
 *
 *  **What is deliberately never cached**, because caching any of it would be
 *  worse than being offline:
 *
 *  - anything but GET;
 *  - anything cross-origin (the font CDN included — it has its own caching and
 *    an opaque response tells us nothing about whether it worked);
 *  - `/api/`, which is the session, the project list and every mutation. A
 *    stale answer here is a lie about somebody's data, and a cached 200 for a
 *    request that should have 401'd is a security bug;
 *  - `/preview/` and `/socket.io/`, which are a live container and a live
 *    connection and mean nothing when replayed.
 *
 *  So the cache holds exactly two things: the built assets under `/assets/`,
 *  whose names carry a content hash and are therefore immutable, and the
 *  navigation shell.
 */

/** Bumped when the strategy changes, not when the app does — the app's own
 *  assets are content-hashed, so a deploy produces new URLs rather than stale
 *  ones. Changing this name is what evicts everything from the old scheme. */
const CACHE = "rc-shell-v1";

/** The navigation fallback. One entry, because this is a single-page app and
 *  every route resolves to the same document. */
const SHELL = "/index.html";

self.addEventListener("install", (event) => {
  // Only the shell is fetched up front. Assets arrive as they are used, which
  // is what keeps this free of a build-time manifest.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(SHELL, { cache: "reload" })))
      // A failed install would leave the previous worker in place for ever,
      // and this one is best-effort by design.
      .catch(() => undefined),
  );
  // Take over on the next load rather than waiting for every tab to close.
  // Safe here because the cache holds only immutable assets and one shell.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((name) => name !== CACHE).map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Whether this request may be served from, or put into, the cache. */
function cacheable(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/api/")) return false;
  if (url.pathname.startsWith("/preview/")) return false;
  if (url.pathname.startsWith("/socket.io/")) return false;
  return true;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (!cacheable(url)) return;

  // Navigations: network first, so a deploy reaches people, with the cached
  // shell as the fallback that makes this whole file worth having.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(SHELL, copy));
          return response;
        })
        .catch(() =>
          caches
            .match(SHELL)
            .then(
              (cached) =>
                cached ??
                new Response("Offline, and nothing cached yet.", {
                  status: 503,
                  headers: { "Content-Type": "text/plain" },
                }),
            ),
        ),
    );
    return;
  }

  // Everything else: cache first. The names under /assets/ carry a content
  // hash, so a hit is never stale — a changed file is a different URL.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request).then((response) => {
        // Only complete, same-origin, successful responses. An opaque or
        // partial response cached here would be indistinguishable from a
        // working one on the next load.
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
