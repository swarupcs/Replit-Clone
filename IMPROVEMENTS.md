# Improvements roadmap

_Composed: 2026-08-22, after the fixes for dev-server restart (`4ef32af`) and
preview refresh on save (`608a08d`). Ordered by recommendation; each item notes
what it is, why it matters, and where it would live._

---

## High value — reliability of what just broke

### 1. Surface dev-server errors in the preview ✅ (done)
Done: the preview proxy reports every page/script response to a health
announcer, which tells the project's room `previewError`/`previewRecovered`
once per bout (debounced); the preview pane shows a banner pointing at the
Output pane, cleared on recovery or restart.
A save with a syntax error reloads into the framework's error overlay, but
nothing in the Run pane or preview toolbar explains that a compile failed.
- **What:** a compile-failed indicator on the preview pane (from run-output
  patterns, or a manual reload affordance next to the error).
- **Why:** closes the loop users hit when editing broken code — the case that
  looked like "changes not reflected" in the original report.

### 2. True HMR for Vite templates on Windows/macOS ✅ (done)
Done: the templates already mapped `CHOKIDAR_*` to `server.watch` (`e31d89c`);
what clobbered HMR was our own `previewChanged` full reload. The proxy's
upgrade handler now counts each project's live `/@vite-hmr` sockets
(`service/hmrSockets.ts`), and the preview announcer stands down while any is
connected — Vite pushes the update itself and the preview keeps its state.
Sockets that drop fall back to the full reload automatically.

### 3. Notify watchers inside the container ✅ (done)
Done: the project watcher now reports WHICH files changed, and
`service/containerTouch.ts` batches one `docker exec touch -c` per change
window (deduped, capped at 200 files, `watchPolling`-gated so Linux hosts
skip it) — a real write from the container's side of the mount, so inotify
fires for terminal-started tools that read none of the polling env vars.
`-c` keeps deletions from being resurrected.

## Medium — from the original analysis, still open

### 4. Observability: structured request logging with correlation IDs ✅ (done)
Done: the HTTP half already existed (`middlewares/requestLogger.ts` over
`lib/logger.ts`'s AsyncLocalStorage); the socket half was the gap. New
`middlewares/socketLogger.ts` gives each admitted editor connection one
correlation id, re-enters the log context for every inbound packet (so logs
inside event handlers carry `requestId`/`userId`/`projectId`), and logs
connect/disconnect; `requireAuth` now stamps `userId` into the HTTP context
via `extendLogContext` too.
- **Where:** a `requestLogger`/socket handshake middleware pair in
  `apps/server/src/middlewares/`, logger already in `lib/logger.ts`.

### 5. CSP headers on the preview proxy ✅ (done)
Done: the preview now answers every response — proxied pages, the guard's own
error pages, everything — with the platform's CSP instead of the sandbox's:
`frame-ancestors 'self' <web origin>; base-uri 'self'; object-src 'none'`.
Only directives that hold for every template are set (previews are arbitrary
user apps: inline scripts, eval, HMR websockets), so the additions are the
moves a hostile document can't do with plain script: an injected `<base>`
redirecting every relative URL to an attacker's host, and plugin-embed
payloads. The dev server's own CSP/X-Frame-Options are dropped as before.
- **Where:** `apps/server/src/routes/preview.ts`.

### 6. Git panel upgrades ✅ (mostly done)
Done: a **diff view** — clicking a changed file expands its patch in place,
add/delete coloured with both files' line numbers; the server had computed
these all along and nothing ever asked for them. And **branches** — list,
create and switch, with a switch refused unless the worktree is clean and the
project's shared documents dropped afterwards so none writes the old branch's
text back. Failures now report git's own message rather than the status code.

Still open: staging individual **hunks**, which needs a patch editor to be
worth anything, and **remotes** (push/pull/clone), which needs a design for
storing credentials reachable from a container running untrusted code.
- **Where:** `apps/web/src/components/organisms/SourceControlPanel/`,
  `apps/server/src/service/gitService.ts`.

### 7. Terminal UX ✅ (mostly done, before this entry was written)
This item was stale on arrival. Multiple terminals shipped with the split-pane
work: `BottomPanel` runs a tab per shell, each with its own socket and PTY, and
panes are hidden rather than unmounted so switching tabs cannot kill a shell.
The gateway already gave every terminal its own id so two on one project are
watched and released separately. `BrowserTerminal` keeps 5000 lines of
scrollback and reconnects on its own with backoff, which is what the
"restart-shell button" was for.

What is genuinely left: scrollback that survives a *reload* (it survives a
reconnect today), and side-by-side terminals rather than tabbed ones.
- **Where:** `apps/web/src/components/organisms/BottomPanel/`,
  `apps/web/src/components/molecules/BrowserTerminal/`.

## Low — nice to have

### 8. Per-app READMEs ✅ (done)
Done: `apps/server/README.md` and `apps/web/README.md` — layout, the handful of
conventions worth knowing before changing anything, how to run each suite, and
pointers to `CONTRIBUTING.md` and `docs/SECURITY.md`.

### 9. E2E coverage for the new flows ✅ (done)
Done: **EDITOR share-link redemption** (`e2e/share-link.spec.ts`) — the owner
makes an edit link, a second account opens it in the browser, and the grant is
checked from both sides: the guest can read the tree, is still refused a rename
(an edit link is not a handover), and the owner sees them listed as an EDITOR.

Getting it to run at all meant splitting the suite's gate. It skipped
everything unless Docker was up, but this flow starts no container — only the
ones that run a project need a daemon. `global-setup` now decides both
separately, so the credential-free half runs on a machine without Docker.

Also done: **save → preview reloads** (`e2e/preview-reload.spec.ts`). The
existing flow saves once *before* the dev server is up, so the preview is
correct because it was never wrong. This is the other half — a second save with
the dev server running and the preview already on screen, and nothing touched
afterwards. It carries a different marker per save, so a preview still showing
the first version cannot be mistaken for one that reloaded.

Checked with a negative control rather than assumed: with the `previewChanged`
announcement disabled the spec fails, and with it restored it passes.
- **Where:** `apps/web/e2e/`.

### 10. Boot-time sweep for orphaned containers ✅ (done)
Done: `reconcileOnBoot` in `containers/containerManager.ts` lists every
`rc-project-*` container against the project ids in the database and
force-removes the ones no row claims. Project *directories* with no row are
reported rather than deleted — a row missing at boot more likely means the
database is not the one this server used last than that the user's files are
garbage, and deleting them would be unrecoverable.

---

## Recommended order

Items 1–5 and 7–10 are done. 6 is done bar a push button it should not have
(see `docs/SECURITY.md`).

`docs/REPLIT_CLONE_PLAN.md` supersedes this list and sequences what is left.
