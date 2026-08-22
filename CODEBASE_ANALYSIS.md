# Codebase Analysis — Fixes & Enhancements

_Analyzed: 2026-08-22_

## Summary

The codebase (pnpm monorepo: React 19 + Vite web IDE, Express/socket.io/dockerode server, shared Zod contracts, Docker sandbox images) is unusually clean and security-hardened. There are **no real bugs, stubs, or TODO debt**. The items below are small hardening nits plus meaningful enhancement opportunities.

---

## Fixes (small, prioritized)

### 1. Content-Disposition header injection (low risk) — ✅ DONE
- **Where:** `apps/server/src/controllers/fileTransferController.ts:130`
- **Issue:** Download filename strips `"` and `\` but not CR/LF characters, leaving a theoretical header-injection vector into `Content-Disposition`.
- **Fix:** ✅ Done — `sanitizeHeaderFilename()` strips quotes, backslashes, and all control bytes (incl. CR/LF) from the quoted filename; an RFC 5987 `filename*` fallback preserves the exact name when something was stripped. Test added in `fileTransferController.test.ts`.

### 2. Test coverage gaps in the riskiest modules — ✅ DONE
- **Where (server):** `socketHandlers/editorHandler.ts` (658 lines), `terminal/terminalGateway.ts`, `containers/containerManager.ts`
- **Where (web):** `ProjectPlayground.tsx`, `Dashboard.tsx`
- **Issue:** The most complex, race-prone code has no direct tests. Recent commits are all race-condition fixes in exactly this area (save-buffer races, watcher behavior on Windows/macOS).
- **Fix:** ✅ Done — added `socketHandlers/editorHandler.test.ts` (24 tests: file ops, traversal/refusal paths, viewer READ_ONLY on every write event, shared-document join/save/relay/awareness guards, run relay and auto-start gating, search budget, disconnect cleanup) and `terminal/terminalGateway.test.ts` (8 tests over a real HTTP server + WebSocket client: subprotocol auth, viewer rejection, early-input buffering before the container exists, 4403 revocation close, 1011 container-failure close reason). `containerManager.ts` core Docker logic remains untested (needs a daemon); `ProjectPlayground.tsx`/`Dashboard.tsx` remain open.

### 3. Generated Prisma client inside `src/` — ✅ NO CHANGE NEEDED
- **Where:** `apps/server/src/generated/prisma`
- **Issue:** Build artifact lives in the source tree; risk of accidental imports or commits.
- **Finding:** ✅ Verified it is already ignored via `apps/server/.gitignore` (`src/generated/`), so it cannot be committed. Relocating the generator output would change the schema, tsconfig, and every import for no functional gain — left as is.

---

## Enhancements

### Features
| Enhancement | Notes |
|---|---|
| **Editable share links** — ✅ DONE | `rotateShareToken` now takes a role; the create-link endpoint accepts `VIEWER`/`EDITOR` (default VIEWER) and the sharing listing returns `shareRole`. An EDITOR link is still a named grant — redeeming adds the signed-in user as a collaborator the owner can see and demote, never an anonymous write credential. ShareDialog offers a role selector for the link and a tag showing what the active link grants. |
| **Cross-file search & replace** — ✅ DONE | `replaceInProject` socket event (editor-only, shares the search budget). The existing search worker gained a replace mode under the same deadline, with caps on files rewritten (200) and bytes added (32 MB); shared documents for rewritten files are dropped so they cannot write the old text back. SearchPanel shows a "Replace with" input + replace-all button (editors only) and re-runs the search afterwards. |
| **Terminal improvements** | Persistent scrollback across reconnects, split terminals, restart-shell button. |
| **Editor polish** | Command palette, go-to-definition. |
| **Git panel upgrades** | Currently argv-array exec only; add diff view, branch visualization, staging individual hunks. |

### Operations / Quality
- **E2E tests** — ✅ DONE | Playwright flow (`apps/web/e2e/`, `pnpm --filter web e2e`): signup → create static playground → edit in Monaco → Ctrl+S → dev server in a real container → preview proxy shows the edit. Runs against the developer's own `pnpm dev` stack and skips cleanly when it isn't up (global-setup probes web + API health). Each run deletes its project afterward so containers don't fill the concurrency cap. Exposed and fixed a real bug: deleting a project with a live run left its container running forever (`removeContainer` now stops before removing).
- **Docs** — add `CONTRIBUTING.md`, per-app READMEs, and a `docs/` page for the security model (path traversal choke point, argv-array exec, token handling) — it's the project's strongest point and deserves a write-up.
- **Observability** — structured request logging with correlation IDs to help debug socket-heavy interactions (editor, terminal, watcher), where most recent bugs lived.
- **Security extras** — `SECURITY.md` with a disclosure policy; consider CSP headers on the preview proxy.

---

## Suggested priority order

1. Content-Disposition CR/LF sanitize (minutes)
2. Tests for `editorHandler.ts` / `terminalGateway.ts`
3. Cross-file search & replace
4. EDITOR share links
5. E2E Playwright flow test
6. Docs (security model + CONTRIBUTING)

## What's already solid (no action needed)

- **Security:** path traversal handled at a single choke point (`utils/projectPaths.ts`), argv-array Docker/git exec (no shell), 25 MB upload cap with quota checks, JWT + rotating hashed refresh tokens with replay detection, rate limiting, `TRUSTED_PROXY_HOPS` instead of blanket `trust proxy`.
- **Hygiene:** no TODO/FIXME/HACK comments, no hardcoded secrets, `.env`/`dist/`/`projects/` correctly gitignored, no console.log noise.
- **CI:** typecheck, lint, test, build on Node 22 with a Postgres service and concurrency cancellation.
- **Tests:** ~40 server test files + web store/component tests, including DB-backed tests that skip gracefully without `TEST_DATABASE_URL`.
