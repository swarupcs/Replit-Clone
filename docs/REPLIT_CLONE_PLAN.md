# Replit / CodeSandbox clone — implementation roadmap

_Composed: 2026-08-25. Supersedes `CODEBASE_ANALYSIS.md` (2026-08-22) and
`IMPROVEMENTS.md` (2026-08-22), both of which are carried forward below rather
than discarded._

---

## 0. What this document is, and the one thing it corrects

The brief that produced this roadmap assumed a skeleton project that needed a
sandbox runtime, an editor, a terminal, a preview and collaboration built from
nothing. **That is not this repository.** Every one of those exists, works, and
is tested. Writing a plan that pretended otherwise would have produced fifteen
phases of work that is already merged.

So Phase 0 below is a verification pass — what actually runs, measured, not
assumed — and the phases after it address the gaps that are genuinely still
open. The scope headings from the brief are all answered in §3; most are
answered with "done, here is where it lives".

### Verification performed for this document

| Check | Command | Result |
|---|---|---|
| Install | `pnpm install --frozen-lockfile` | clean, 774 packages |
| Shared build | `pnpm --filter @replit-clone/shared build` | clean |
| Prisma client | `prisma generate` | clean (7.9.1) |
| Typecheck | `pnpm -r typecheck` | **clean, 3/3 packages** |
| Lint | `pnpm -r lint` | **clean, 3/3 packages** |
| Tests | `pnpm -r test` with `TEST_DATABASE_URL` | **1056 passing** — 830 server (56 files) + 226 web (17 files), 0 failing |
| Build | `pnpm --parallel --filter "./apps/*" build` | clean |
| Debt scan | `grep -rn "TODO\|FIXME\|HACK"` over `apps/`, `packages/` | **0 hits** |

Tests were run against a real Postgres 16 started for the purpose, so the
DB-backed tests (refresh-token rotation, replay detection, revocation, sharing)
actually executed rather than skipping.

**No bugs were found.** Not "none worth fixing" — the typecheck, lint, full
suite and build are all green, there is no suppression debt (two
`eslint-disable` lines, both with a stated reason), no `TODO`, no stubbed
function, and no dead code path found by reading. The prior analysis reached the
same conclusion three days earlier and it still holds. The prioritized bug-fix
list the brief asked for is therefore **empty**, and §5 records that honestly
instead of inventing entries to fill it.

---

## 1. Current state

A pnpm monorepo, TypeScript throughout.

```
apps/web        React 19 + Vite 6      the IDE
apps/server     Express + socket.io + dockerode
packages/shared contracts imported by both
images/         sandbox base images (node, python, go)
```

The shared package is load-bearing: the socket event map, REST response shapes
and the file-tree type are declared once, so a renamed event is a compile error
rather than a silent no-op.

### Architecture as built

```mermaid
flowchart TB
    subgraph Browser
        IDE["React IDE<br/>Monaco · xterm · Yjs"]
        PV["Preview iframe"]
    end

    subgraph Server["Express server"]
        REST["REST /api/v1"]
        SIO["socket.io<br/>editor events"]
        TWS["Terminal WebSocket<br/>(subprotocol auth)"]
        PROXY["Preview reverse proxy<br/>/preview/:projectId/"]
        COLLAB["Yjs relay + single-writer<br/>collabService"]
        WATCH["chokidar project watcher"]
        MGR["containerManager<br/>dockerode"]
    end

    DB[("Postgres<br/>Prisma")]
    FS[("apps/server/projects/&lt;id&gt;")]

    subgraph Sandbox["Per-project container (isolated bridge)"]
        SH["shell (docker exec)"]
        DEV["dev server"]
    end

    IDE -->|JWT| REST --> DB
    IDE <-->|events| SIO --> COLLAB --> FS
    IDE <-->|binary| TWS --> SH
    PV --> PROXY --> DEV
    SIO --> MGR --> Sandbox
    WATCH --> FS
    WATCH -->|treeChanged / previewChanged| SIO
    Sandbox -.->|bind mount| FS
```

### Data model (Prisma, 4 migrations applied)

| Model | Purpose | Notable fields |
|---|---|---|
| `User` | account | `email` unique, `passwordHash?`, `githubId?` unique, `emailVerifiedAt?` |
| `UserToken` | reset / verify | `tokenHash` unique, `purpose` enum, `expiresAt`, `usedAt?` |
| `RefreshToken` | revocable sessions | `tokenHash` unique, `familyId`, `revokedAt?` — rotation + replay detection |
| `Project` | workspace | `template`, `ownerId`, `envVars` Json, `shareToken?` unique, `shareRole` |
| `ProjectCollaborator` | sharing | `role` (`VIEWER`/`EDITOR`), unique per (project, user) |

### API surface

**REST** — `/api/v1`

- Auth: `signup`, `login`, `refresh`, `logout`, `me`, `password-reset/{request,confirm}`, `verify-email`, `providers`, `github`, `github/callback`
- Projects: `GET|POST /projects`, `GET /templates`, `PATCH /:id`, `DELETE /:id`, `POST /:id/duplicate`, `GET /:id/{tree,ports,export,env,files}`, `PUT /:id/env`
- Sharing: `GET /:id/sharing`, `PUT /:id/collaborators`, `DELETE /:id/collaborators/:userId`, `POST|DELETE /:id/share-link`, `GET /share/preview`, `POST /share/redeem`
- Git: `GET /:id/git/{status,diff,log}`, `POST /:id/git/{init,stage,unstage,commit}`
- Ops: `GET /ping`, `GET /health`, `GET /metrics`, `GET /ai/status`

**Socket (client → server)** — `readFile`, `writeFile`, `createFile`,
`deleteFile`, `createFolder`, `deleteFolder`, `renameEntry`, `moveEntry`,
`runStart`, `runStop`, `runRestart`, `runSubscribe`, `statsRequest`, `search`,
`replaceInProject`, `docJoin`, `docLeave`, `docSave`, `docUpdate`,
`docAwareness`, `aiAsk`, `aiCancel`

**Socket (server → client)** — `*Success` acknowledgements, `treeChanged`,
`projectAccess`, `docSync`, `docUpdate`, `docAwareness`, `docPeers`, `docSaved`,
`docExternalChange`, `runState`, `runOutput`, `runHistory`, `previewReady`,
`previewChanged`, `previewError`, `previewRecovered`, `containerStats`,
`searchResults`, `replaceResult`

**Terminal** — a separate WebSocket on the same HTTP port; the access token
travels in the WebSocket subprotocol, because a browser cannot set headers on an
upgrade and a query-string token would land in access logs.

---

## 2. Gap analysis vs. Replit / CodeSandbox

Honest scoring of what a user would notice.

| Capability | Replit | Here | Gap |
|---|---|---|---|
| Projects from templates | ✅ | ✅ 12 templates | none |
| Editor (Monaco, tabs, split, search, quick-open) | ✅ | ✅ | command palette, go-to-definition |
| Real shell | ✅ | ✅ PTY over WS, tabbed, multiple per project | side-by-side rather than tabbed |
| Run / stop / restart | ✅ | ✅ + live output, exit codes | none |
| Preview | ✅ | ✅ proxy, auto-reload, HMR-aware | none |
| Multiplayer editing | ✅ | ✅ Yjs CRDT + cursors | none |
| Sharing / permissions | ✅ | ✅ viewer/editor/owner + links | none |
| Container isolation & limits | ✅ | ✅ 512 MB, 0.5 CPU, 256 PID, caps dropped | none |
| Quotas | ✅ | ✅ per-user projects/disk/containers | none |
| Git | ✅ full | ✅ status/stage/commit/log/diff/branches | no remotes, no hunk staging, no discard |
| AI assistant | ✅ | ✅ panel + apply-change | none |
| Env vars / secrets | ✅ | ✅ injected, rebuild on change | none |
| Package caching | ✅ | ✅ named cache volume | none |
| Deployment of user apps | ✅ | ❌ | out of scope (see §6) |

**The gap is git.** Everything else a user touches daily is built. Diffs went
further than expected: the server computes them (`gitService.diff`), the route
serves them (`GET /:id/git/diff`), the shared response type is declared, and
`getGitDiffApi` is written in the web client — and **no component ever called
it**. The whole chain existed bar its last link, so a source-control panel
listed changed files without being able to show what changed in them.

---

## 3. The brief's fifteen scope areas, answered

1. **Auth & accounts** — done. Argon2, JWT access + rotating hashed refresh
   tokens with family revocation on replay, GitHub OAuth, email verification,
   password reset, per-resource authorization (`service/projectAccessService.ts`).
2. **Projects/workspaces** — done. CRUD, 12 templates, duplicate, rename,
   zip export, share links, listing.
3. **Persistence** — done. Postgres + Prisma, 4 migrations, files on disk under
   `apps/server/projects/<id>`, quota-enforced.
4. **Sandbox runtime** — done. One container per project, 512 MB / 0.5 CPU /
   256 PIDs, all caps dropped, `no-new-privileges`, unprivileged user, isolated
   bridge, 20-minute idle reaper, boot reconciliation of orphans.
5. **Filesystem API** — done. Full CRUD + move + upload/download, all paths
   through one choke point (`utils/projectPaths.ts`) rejecting traversal,
   absolute, Windows/drive-relative forms and NUL bytes. 21 tests on that file
   alone.
6. **Editor** — done bar polish. Monaco, tabs, split panes, dirty state,
   format-on-save, project-wide search **and replace**, quick-open, diff against
   disk, persisted settings. → **Phase 4** added the command palette;
   go-to-definition is scoped in §7.
7. **Terminal** — done. Real PTY, resize, 5000-line scrollback, automatic
   reconnect with backoff, and a tab per shell with several per project.
   → **Phase 3** found this already built and pinned it with tests.
8. **Run / stop** — done. Per-template start command, streamed stdout/stderr,
   exit codes, restart, persisted run log.
9. **Preview** — done. Reverse proxy (not a published port), auto-reload on
   save, HMR-socket detection, error/recovery banners, own-origin option.
10. **Realtime collaboration** — done. Yjs per open file, server is sole disk
    writer while a doc is live, presence cursors, peer counts.
11. **Reliability & ops** — done. Structured logs with correlation IDs across
    HTTP *and* sockets, `/health`, `/metrics`, graceful shutdown, boot
    reconciliation, client reconnect, error boundaries.
12. **Security hardening** — done, and documented in `docs/SECURITY.md`.
    Rate limiting, `TRUSTED_PROXY_HOPS`, argv-array exec (no shell anywhere),
    cookie stripping on preview, typed tokens, CSP, 404-not-403 on unauthorized.
13. **Testing & CI** — done. 1056 tests, Playwright E2E, GitHub Actions running
    typecheck/lint/test/build plus a sandbox-image job. → **Phase 5** widens
    coverage to the two untested pages.
14. **Deployment** — done. Dockerfiles, four compose files (dev, prod, Dokploy,
    Dokploy-backend-only), documented env vars, Vercel split-deploy guide.
15. **UX polish** — largely done. → **Phase 6** picks up the remainder.

---

## 4. Assumptions and trade-offs

Recorded because this roadmap was written without asking.

- **I did not rewrite working subsystems.** The brief's phrasing invited
  building a sandbox runtime and collab engine from scratch; both exist and are
  better than a rewrite would be in one pass. Rewriting them would have been
  destruction, not delivery.
- **Git is the priority** because it is the only area where a user hits a wall,
  and because a diff endpoint already exists unused — the cheapest real value in
  the repository.
- **No hunk-level staging in the first git phase.** The existing code comment is
  right: hunk staging needs a patch editor, and half of one is worse than none.
  Phase 2 ships whole-file diffs; hunk staging is deferred to Phase 7.
- **Branch operations stay local.** Push/pull needs credential storage inside a
  sandbox that runs untrusted code — a real security design, not a feature. It
  is scoped in Phase 7 and deliberately not rushed.
- **Deploying user apps to the public internet is out of scope.** It would mean
  running untrusted containers on reachable ports, which contradicts the stated
  security model ("do not expose this to the internet").
- **Docker is unavailable in the environment this plan was written in** (client
  present, no daemon). Container-touching code cannot be executed here, so those
  paths are verified by unit tests with a faked docker client, as the repo
  already does. Anything needing a live daemon is called out per phase.

---

## 5. Bug-fix list

**Empty.** See §0. Typecheck, lint, 1056 tests and the build are green; there is
no TODO/FIXME debt and no stub. The two documentation inaccuracies found are
tracked as Phase 1 work, not as bugs:

| Item | Where | Fix |
|---|---|---|
| Test count stale ("291 tests") | `README.md` | 1056 |
| `IMPROVEMENTS.md` #10 lists the orphan sweep as open | `IMPROVEMENTS.md` | `reconcileOnBoot` implements it; mark done |

---

## 6. Phases

Ordered by user-visible value. Each is independently shippable and gets its own
commit.

### Phase 1 — Documentation truth-up ✅
**Goal:** no statement in the repo's docs is false.
- `README.md`: correct the test count; note `pnpm --filter web e2e`.
- `IMPROVEMENTS.md`: close #10 (orphan sweep — `reconcileOnBoot` does it).
- Add this roadmap.
**Acceptance:** every command and count in the README matches observed output.
**Verify:** run each documented command.

### Phase 2 — Git diff view ✅ *(the main gap)*
**Goal:** see what changed in a file, from the source-control panel.
- `utils/parseUnifiedDiff.ts` — new: unified patch → hunks, with both files'
  line numbers resolved. Pure and tested apart from the component, the same
  split `gitService.parseStatus` makes on the server. 13 tests.
- `SourceControlPanel/DiffView.tsx` — new: renders the patch inline, add/delete
  colouring, dual line-number gutters, `+n −n` summary, binary and error states.
  Cancels in-flight requests so a late answer cannot overwrite a newer file.
- `SourceControlPanel.tsx` — a row now expands its diff; the file icon opens the
  file for editing. One diff open at a time; staged and unstaged rows for the
  same file expand independently. 10 tests.
- `getGitDiffApi` needed no work — it already existed, unused.
**Verified:** typecheck, lint, 1079 tests (+23), build — all clean.

### Phase 3 — Multiple terminals ✅ *(already built; pinned with tests)*
**Goal, as planned:** more than one shell per project.
**What was actually found:** already implemented and shipped with the
split-pane work. `BottomPanel` runs a tab per shell, each with its own socket
and PTY; panes are hidden rather than unmounted so a tab switch cannot kill a
shell; the gateway gives every terminal its own id so two on one project are
watched and released separately. `IMPROVEMENTS.md` #7 listing it as open was
stale, and this roadmap inherited that error.

Building it again would have been destructive, so the phase became what the
feature actually lacked — it had **no tests at all**, despite a fiddly tab
lifecycle:
- `BottomPanel.test.tsx` — 12 tests: add/close/switch, panes staying mounted
  across switches (a remount would kill the PTY), renumbering by position so
  closed ids never show as gaps, selection moving off a closed shell, the last
  shell being replaced rather than leaving an empty panel, middle-click close,
  run-start pulling focus to the output, and a viewer getting no shell.
- `IMPROVEMENTS.md` #7 corrected.
**Verified:** typecheck, lint, 1091 tests, build — all clean.

### Phase 4 — Command palette ✅
**Goal, as planned:** command palette and go-to-definition. The palette
shipped; go-to-definition turned out to be a phase of its own and moved to §7.
- `lib/commands.ts` — new: the `Command` shape and `filterCommands`, ranking
  over the existing fuzzy scorer against `"Category: Title"` so "git" reaches
  "Source control: Commit". Disabled commands are kept and greyed with a
  reason rather than hidden — a palette that silently omits "Stop" reads as a
  missing feature. 8 tests.
- `CommandPalette.tsx` — new: same shape as QuickOpen deliberately (modal high
  on the page, one input, arrow navigation), since they are one gesture aimed
  at different things. Closes before running so a command can open its own
  dialog. 12 tests.
- `ProjectPlayground.tsx` — 12 commands wired to the *same* handlers the
  buttons and shortcuts use, never a second copy of the behaviour; Ctrl/Cmd
  +Shift+P registered alongside the existing chords.
- `test/setup.ts` — jsdom ships no `scrollIntoView`; stubbed, since any
  keep-the-row-in-view list calls it from an effect on every render.
**Verified:** typecheck, lint, 1111 tests (+20), build — all clean.

**Why go-to-definition moved:** Monaco creates a model only when a tab is
opened (`EditorComponent.tsx:189`), so its TS worker only ever sees files the
user already has open — cross-file navigation would find nothing. Making it
real needs every project source file in the worker, and the socket API reads
one file per round trip, so it needs a bulk-read event, an invalidation story
for external writes, and a memory budget for large projects. That is a phase,
not a step, and half of it would be worse than none.

### Phase 5 — Test coverage for the two untested pages ✅
**Goal:** `ProjectPlayground.tsx` and `Dashboard.tsx` — the largest untested
surface left, and the two files `CODEBASE_ANALYSIS.md` left open.
- `Dashboard.test.tsx` — 12 tests: listing, opening a card, filtering by name
  *and* template, case/whitespace handling, ordering by last activity rather
  than creation, delete-behind-a-confirmation, duplicate, share, create, and
  staying put when create fails.
- `ProjectPlayground.test.tsx` — 21 tests: layout toggles and their
  persistence, sidebar view switching, every hotkey (including Ctrl+P and
  Ctrl+Shift+P not claiming each other's chord), the palette's run commands
  against live run state, a viewer being refused, and both banners.
  Monaco/xterm/preview are stood in for; the socket is a fake whose captured
  handlers deliver `projectAccess` the way the server does.
**Verified:** typecheck, lint, 1144 tests (+33), build — all clean.

Two things the tests had to be taught rather than assume: react-query hands a
mutation function a context argument beside the variable, and access level is
null until the server announces it, so a page rendered without that event is
correctly read-only.

### Phase 6 — Remaining polish ✅ *(partly; one item deliberately not done)*
- **Per-app READMEs** ✅ (`IMPROVEMENTS.md` #8). `apps/server/README.md` and
  `apps/web/README.md`: layout, the three things to know before changing
  anything, how to run the tests, and pointers to `CONTRIBUTING.md` and
  `docs/SECURITY.md`. Every structural and behavioural claim in them was
  checked against the code — one draft assertion ("container tests use a faked
  docker client") was wrong and was corrected: the tests use hand-built
  stand-ins typed as dockerode's `Container`, and `containerManager.ts`'s own
  Docker calls remain covered only by the E2E suite.
- **Monaco chunking** ✅ *already done*. `vite.config.ts` already splits monaco,
  xterm, antd and react-icons into their own chunks, with
  `chunkSizeWarningLimit` set just above Monaco so the warning still fires if
  anything else grows that large. Monaco is ~4 MB self-hosted and behind the
  lazy playground route; there is nothing further worth doing. The roadmap
  listed this without checking — corrected.
- **E2E specs** ❌ *not written, deliberately*. Save→preview-reload and EDITOR
  share-link redemption both need a live stack and a Docker daemon to
  exercise. This environment has the Docker client but no daemon
  (`/var/run/docker.sock` absent), so a spec written here could be typechecked
  but never once run. An end-to-end test that has never passed is not
  coverage — it is a claim. Left for an environment with a daemon; the two
  flows and where they belong are recorded in `IMPROVEMENTS.md` #9.

### Phase 7 — Git branches ✅
The deferred item whose design question turned out to have a defensible answer,
so it was built rather than left.

**The two hazards, and what was decided:**
- *Dirty worktree.* git is permissive — it carries uncommitted changes across
  when they do not conflict. In an editor where those files are also open in
  other people's tabs, that means edits silently follow you onto another branch
  and get committed there. `switchBranch` refuses unless the worktree is clean
  and says why.
- *Live shared documents.* A switch rewrites files under anyone with the
  project open, and a live Yjs document still holding the old branch's text
  would write it back over the new one. The controller calls `forgetProject`
  after a successful switch — the same move the search-and-replace path already
  makes — so every editor reloads from disk. It is called only on success, so a
  refused switch costs nobody their buffer.

**Shipped:** `parseBranches` + `branches`/`createBranch`/`switchBranch`/
`assertValidBranchName` in `gitService.ts`; `GET /git/branches` and
`POST /git/branch` (viewer to list, editor to change); shared `GitBranch`
types; a branch picker and a new-branch dialog in the panel, with viewers
getting the plain label they had before.

Also fixed on the way through: the panel reported git's refusals as "Request
failed with status code 400", losing the server's actual message — which for
these is the entire point. `reasonFrom` now reads `{ message }` off the error
body, which improves stage, unstage and commit failures too.

**Two real bugs caught before they shipped**, both in git argument order:
`git checkout -- <name>` treats the name as a *pathspec*, so it would have
tried to discard a file rather than switch branch; and `check-ref-format
--branch -- <name>` is a usage error that rejects every name. Verified against
a real git repository, and corrected to `checkout <name> --` and
`check-ref-format --branch <name>`. The leading-dash guard is what keeps
dropping that separator safe.

**Verified:** typecheck, lint, 1169 tests (+25), build — all clean.

### Phase 8 — Still deferred, deliberately
Each needs a design decision rather than an afternoon.
- **Git remotes** — push/pull/clone. Blocked on credential storage for a
  container running untrusted code. Needs a threat model first.
- **Hunk-level staging** — needs a patch editor (see §4).
- **Cross-file go-to-definition** — needs the project's sources in Monaco's TS
  worker: a bulk-read socket event, invalidation on external writes, and a
  memory budget. See Phase 4 for why it is not a one-liner.
- **Discard / revert changes** — destructive; needs confirmation UX and an
  interaction story with live Yjs documents.

---

## 7. Progress

- [x] Phase 0 — verification (green across the board, no bugs)
- [x] Phase 1 — documentation truth-up
- [x] Phase 2 — git diff view
- [x] Phase 3 — multiple terminals (already built; pinned with tests)
- [x] Phase 4 — command palette
- [x] Phase 5 — page test coverage
- [x] Phase 6 — remaining polish (E2E specs deferred: no Docker daemon here)
- [x] Phase 7 — git branches
- [ ] Phase 8 — still deferred (remotes, hunk staging, discard, go-to-definition)
