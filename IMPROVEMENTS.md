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

### 6. Git panel upgrades
Currently commit/status only. Add a diff view, branch visualization, and
staging individual hunks.
- **Where:** `apps/web/src/components/organisms/SourceControlPanel/`,
  `apps/server/src/service/gitService.ts`.

### 7. Terminal UX
Persistent scrollback across reconnects, split terminals, restart-shell button.
- **Where:** `apps/web/src/components/molecules/BrowserTerminal/`,
  `apps/server/src/terminal/terminalGateway.ts`.

## Low — nice to have

### 8. Per-app READMEs
`apps/web` and `apps/server` READMEs pointing at `CONTRIBUTING.md` and
`docs/SECURITY.md`.

### 9. E2E coverage for the new flows
Specs for "save → preview reloads" and "EDITOR share-link redemption" would pin
down the two newest features the way `playground-flow.spec.ts` pins the basics.
- **Where:** `apps/web/e2e/`.

### 10. Boot-time sweep for orphaned containers
`removeContainer` now stops before removing, but a sweep for `rc-project-*`
containers with no DB row would clean future strays automatically.
- **Where:** `apps/server/src/containers/containerManager.ts`
  (`reconcileOnBoot` is the natural hook).

---

## Recommended order

Items 1–5 are done. Next: 6 — close the biggest visible feature gap.
