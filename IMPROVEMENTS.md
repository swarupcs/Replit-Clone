# Improvements roadmap

_Composed: 2026-08-22, after the fixes for dev-server restart (`4ef32af`) and
preview refresh on save (`608a08d`). Ordered by recommendation; each item notes
what it is, why it matters, and where it would live._

---

## High value — reliability of what just broke

### 1. Surface dev-server errors in the preview
A save with a syntax error reloads into the framework's error overlay, but
nothing in the Run pane or preview toolbar explains that a compile failed.
- **What:** a compile-failed indicator on the preview pane (from run-output
  patterns, or a manual reload affordance next to the error).
- **Why:** closes the loop users hit when editing broken code — the case that
  looked like "changes not reflected" in the original report.

### 2. True HMR for Vite templates on Windows/macOS
The preview now full-reloads on save everywhere, but Vite projects could keep
component state across edits.
- **What:** map the existing `CHOKIDAR_*` env vars in the templates'
  `vite.config` to `server.watch` — chokidar v3 does not read those env vars
  itself, so the current pass-through does nothing for Vite.
- **Where:** `apps/server/templates/*-vite/vite.config.*`.

### 3. Notify watchers inside the container
Tools started manually in the terminal still rely on the inotify the bind
mount swallows.
- **What:** on file change, `docker exec touch` the changed files (verified to
  work during diagnosis) alongside the preview reload, for projects whose run
  output indicates a watcher-based tool.
- **Where:** alongside `service/previewRefresh.ts`.

## Medium — from the original analysis, still open

### 4. Observability: structured request logging with correlation IDs
Every recent bug (save races, run state, watcher events) lived in socket
interactions that leave no trace to grep afterwards. This would have halved
the diagnosis time of both bugs fixed this session.
- **Where:** a `requestLogger`/socket handshake middleware pair in
  `apps/server/src/middlewares/`, logger already in `lib/logger.ts`.

### 5. CSP headers on the preview proxy
The last open item from `docs/SECURITY.md` — defense in depth against a
compromised sandbox serving hostile markup into the IDE origin's iframe.
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

1 → 4 → 6: finish the preview story, pay down the debugging cost of everything
else, then close the biggest visible feature gap.
