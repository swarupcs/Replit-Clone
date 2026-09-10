/** A preview with no container behind it. plan.md §13.2.
 *
 *  Every preview in this product is a reverse proxy to a dev server inside
 *  Docker. That is the right architecture for the projects it serves and the
 *  wrong one for a shared link: a container costs memory, takes seconds to
 *  start, and is reaped when nobody is looking at it — so an embed on a busy
 *  page is a container per reader, which is why CodeSandbox's embeds work at a
 *  scale this one's cannot.
 *
 *  This is the other half: the source is bundled **in the reader's own
 *  browser** and rendered in a sandboxed iframe. It costs this host nothing
 *  beyond serving some text.
 *
 *  **What it does not cover, said first because this is the row most likely to
 *  be over-sold:** anything with a server. `node-express`, `python-flask`,
 *  `python-fastapi`, `go-http` and every compose project are outside it
 *  permanently — not "not yet". A browser cannot run their server, and
 *  pretending otherwise would produce a preview that renders a blank page for
 *  reasons the reader cannot see.
 */

/** Why a project cannot be previewed in the browser. */
export type BrowserPreviewRefusal =
  /** The template runs a server. Permanent. */
  | "needs-a-server"
  /** A `docker-compose.yml` declares services. Permanent. */
  | "needs-services"
  /** No entry file could be found. Usually fixable by the author. */
  | "no-entry"
  /** More source than is sensible to ship to a browser. */
  | "too-large";

export interface BrowserPreviewPlan {
  supported: boolean;
  reason?: BrowserPreviewRefusal;
  /** A sentence for the reader. On the response rather than derived on the
   *  client, because "this project runs a server" is a fact about the project
   *  and the client should not be re-deriving facts. */
  message?: string;
  /** The file the bundle starts from, project-relative. */
  entry?: string;
  /** Every source file the bundle may need, path to contents. Sent whole:
   *  resolving imports server-side would mean writing half a bundler on the
   *  server to avoid sending a few kilobytes to the browser. */
  files?: Record<string, string>;
  /** Bare imports found in the source, for the worker to fetch from a CDN. */
  dependencies?: string[];
  /** The HTML shell, when the project has one. */
  html?: string;
}

/** The most source this will ship to a browser.
 *
 *  A megabyte of text is already far more than a front-end project's own
 *  source, and the point of this feature is that it is cheap for both ends. A
 *  project past it is one the container preview should serve. */
export const MAX_PREVIEW_BYTES = 1024 * 1024;

/** How many files. A tree with thousands of them is a repository rather than
 *  a sandbox, and walking it to find out is work this endpoint should not do
 *  on every request. */
export const MAX_PREVIEW_FILES = 200;
