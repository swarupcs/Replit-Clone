# Roadmap — one list

_Composed 2026-08-29 by merging every planning document in the repository into
a single status ledger. Each line is marked done or open, and each open line
says what it is blocked on._

## What this replaces

Eight planning documents, deleted in the same commit that created this one:

| Document | Dated | Covered here |
|---|---|---|
| `CODEBASE_ANALYSIS.md` | 2026-08-22 | §2.1 |
| `IMPROVEMENTS.md` | 2026-08-22 | §2.1–2.3 |
| `docs/REPLIT_CLONE_PLAN.md` | 2026-08-25 (§8 to 08-28) | §2.4, §3 |
| `UI_IMPROVEMENTS.md` | 2026-08-26 | §2.5 |
| `docs/VSCODE_PARITY_PLAN.md` | 2026-08-26 | §2.6, §6 |
| `docs/GITHUB_WORKFLOW_PLAN.md` | — | §2.7, §6 |
| `docs/NEXT_IMPROVEMENTS.md` | 2026-08-28 | §3 |
| `run-command.md` | — | `CONTRIBUTING.md` already has the commands |

They are gone from the tree, not from the repository: `git log --diff-filter=D
-- '*.md'` finds the commit that removed them, and `git show <commit>^:<path>`
reads any of them back in full. Their **arguments** live there. Their **state**
lives here, and this file is now the only place that tracks it.

Still present, because none of them is a plan and this replaces none of them:
`README.md` (what the product is), `CONTRIBUTING.md` (how to work on it),
`docs/SECURITY.md` (the trust boundaries and their guards), and the two per-app
READMEs.

The decisions the deleted documents recorded — the ones with a revisit trigger,
which are the ones worth not re-litigating — are carried forward in §6 rather
than left in history where nobody would look for them.

---

## 1. Status at a glance

Verified for this document on 2026-08-29, by running it rather than reading
about it:

| Check | Result |
|---|---|
| `pnpm -r typecheck` | clean, 3/3 packages |
| `pnpm --filter server test` | **1379 passing**, 149 skipped (81 files) |
| `pnpm --filter web test` | **831 passing** (62 files) |
| Debt scan (`TODO`/`FIXME`/`HACK` over `apps/`, `packages/`) | **0 hits** |

The 149 skipped server tests are the DB-gated suites (`TEST_DATABASE_URL`
unset) and the shell-quoting round-trips (`/bin/bash` absent on Windows). Both
run in CI.

**Done: 61 items. Open: 12.** Of the 12, one is a defect, four are unblocked
work, five are blocked on a decision or on infrastructure, and two are
documentation debts.

---

## 2. Done

### 2.1 The 2026-08-22 analysis

- [x] Content-Disposition CR/LF sanitising on downloads — `ef3dd80`
- [x] Tests for `editorHandler.ts` and `terminalGateway.ts` — `cc85903`
- [x] Cross-file search **and replace** — `e40a566`
- [x] EDITOR share links (a named grant, not an anonymous write credential) — `67bc0d2`
- [x] Playwright E2E flow; found and fixed a container leak on project delete — `e27d77b`
- [x] `docs/SECURITY.md` and `CONTRIBUTING.md` — `dda5046`, `7430665`
- [x] Generated Prisma client location — verified already gitignored, no change needed

### 2.2 Reliability

- [x] Preview surfaces dev-server errors — `previewError`/`previewRecovered`, debounced once per bout
- [x] True HMR for Vite templates on Windows/macOS — the announcer stands down while a live `/@vite-hmr` socket exists
- [x] Watchers inside the container are notified — batched `docker exec touch -c` per change window
- [x] Structured logging with correlation ids across **both** HTTP and sockets
- [x] CSP headers on the preview proxy — `frame-ancestors`, `base-uri`, `object-src`
- [x] Boot-time sweep for orphaned containers — `reconcileOnBoot`; directories are reported, never deleted
- [x] The run's log lives where the run does — recorded to `/tmp/rc-run.log` via `script`, replayed on adoption
- [x] The preview stopped reloading itself in a loop — the watcher was reading its own container-side `touch`
- [x] A terminal's shell is ended when its terminal goes away — closing the exec stream does **not** end it; measured

### 2.3 Editor and terminal

- [x] Git panel: diff view, branches (list/create/switch), hunk staging, discard
- [x] Multiple terminals — a tab per shell, each with its own PTY, panes hidden rather than unmounted
- [x] 5000-line scrollback and automatic reconnect with backoff
- [x] Per-app READMEs (`apps/server`, `apps/web`)
- [x] E2E for share-link redemption and for save → preview reload

### 2.4 Product level (`REPLIT_CLONE_PLAN` §8)

- [x] **Package management UI** — a panel per ecosystem, driven through the container
- [x] **Warm containers**, install half — `warmStart.ts` fingerprints manifests and skips a redundant install
- [x] **Static deployments** — build in the container, copy out, serve from a third origin at a generated subdomain
- [x] **Always-on deployments** — the six templates that serve from a process get a long-lived container of their own, budgeted by `MAX_DEPLOYED_SERVICES`
- [x] **Persistent data** — a managed Postgres sidecar per project, sealed generated password, nothing published to the host
- [x] **Fork and public projects** — `Project.visibility`, a `visitor` level ranked *below* viewer, and an explore gallery

### 2.5 UI (`UI_IMPROVEMENTS`)

- [x] **#1 Responsive** — both stages; below 900px the sidebar, panel and preview become drawers over the editor, as CSS over the existing tree so no pane is unmounted and no PTY is lost
- [x] **#2 Focus states and keyboard reach** — `:focus-visible` on every primitive, `role="tree"` with roving tabstop, `role="tablist"` on the strip
- [x] **#3 Presence** — a stack in the status bar and a dot per person on the tree row and tab
- [x] **#4 Command palette** — `Ctrl+Shift+P` over `lib/commands.ts`
- [x] **#5 Global status bar** — promoted out of `EditorComponent`, which retired two bugs at once
- [x] **#6 One notification system per kind** — transient → toast, persistent → status-bar chip
- [x] **#7 Problems view** — a third bottom-panel tab from Monaco markers
- [x] Light theme, skeletons over spinners, the editor empty state as an on-ramp, accessible names on icon buttons

### 2.6 VS Code parity ledger (`VSCODE_PARITY_PLAN` §10.3)

Rows 1–13, all `done`:

- [x] 1 — Monaco options and the settings rows that expose them
- [x] 2 — one extension table, real icon set, folder icons
- [x] 3 — preview tabs, reorder, pin, close-others, MRU `Ctrl+Tab`
- [x] 4 — hand-built light editor theme (`alucard.json`) and the theming audit
- [x] 5 — git gutter decorations
- [x] 6 — git decorations on the tree, files and folders
- [x] 7 — database client against an external connection, SSRF guard first
- [x] 7b — the MongoDB half, as its own component rather than SQL in disguise
- [x] 8 — breadcrumbs, outline, peek, `Ctrl+T`, zen mode
- [x] 9 — merge conflict resolution
- [x] 10 — managed sidecar database and the templates *(Postgres engine only, by decision)*
- [x] 11 — keybinding registry, chords, user editing
- [x] 12 — language servers, Python first, behind `LSP_ENABLED`
- [x] 13 — checkpoint history, then follow mode

### 2.7 GitHub workflow (`GITHUB_WORKFLOW_PLAN` §5)

- [x] 1 — keep the connection (AES-256-GCM under `GITHUB_TOKEN_KEY`)
- [x] 2 — see the repositories
- [x] 3 — import one, cloned **inside a container**, never on the host
- [x] 4 — push without retyping the token
- [x] 5 — pull requests
- [x] 6 — the rest of the loop: upstream state, "open on GitHub", sync
- [x] 7 — a project carries its own run command, read from `package.json` at import

### 2.8 Since (2026-08-29)

- [x] The assistant can offer a change, and a person accepts it — `propose_edit`, reviewed as a diff, applied through the editor's undo stack
- [x] The file tree stopped waking for other people's news — per-row selectors and a memo
- [x] **A crashed deployment no longer reports "live".** `deploymentState`
      reconciles a LIVE service row against `serviceTarget` before answering,
      and reports `failed` with the reason when nothing is listening. Read-time
      only, deliberately not written back: `restoreServices` brings LIVE rows up
      after a host restart, so persisting the failure would mean a crashed app
      were never resurrected.
- [x] **A deployment's log is no longer frozen at publish time.** The same read
      pulls the current tail through `serviceLogs`, falling back to the stored
      one when there is no container to ask.
- [x] **One user can no longer occupy every always-on slot.**
      `MAX_DEPLOYED_SERVICES_PER_USER` (default 2 against a host budget of 5).
      The owner's subdomains are passed into `startService` rather than looked
      up, so `deployContainer` stays a Docker module with no opinion about
      ownership. A full host is a 503; a full account is a 429 that names the
      number, because that one the reader can act on.

---

## 3. Open

### 3.1 Defects — code that is merged and wrong

The three deployment defects listed here were fixed on 2026-08-29 and have
moved to §2.8. One remains.

- [ ] **Public projects have no abuse story.** No report mechanism, no review,
      no rate limit on *publishing* (forking is rate limited as project
      creation). Single-tenant or invite-only is unaffected; a public
      multi-tenant deployment needs all three before `visibility = PUBLIC` is
      safe to expose.

### 3.2 Unblocked — work, not decisions

- [ ] **Language servers beyond Python.** `LANGUAGE_SERVERS`
      (`lsp/lspPolicy.ts:4`) still has exactly one entry, `pylsp`. Everything
      underneath is built and shipping — the gateway with `Content-Length`
      framing, lazy start, idle stop, and the memory refusal that names its
      reason. Adding `gopls` is a registry entry and an image that carries it.
      Development's container default is now 2048 MB, which clears
      `LSP_MIN_CONTAINER_MEMORY_MB` on its own. **The cheapest real win left.**
- [ ] **E2E never runs in CI.** `.github/workflows/ci.yml` has zero mentions of
      playwright or `pnpm e2e`. The specs under `apps/web/e2e/` are the only
      tests that exercise the real stack — Docker, sockets, the preview proxy —
      and they run only when somebody remembers. For a system this
      integration-shaped that is the largest hole in the safety net, and every
      bug the last two months of notes describe as "invisible to the unit tests"
      was of exactly that kind.
- [ ] **Four env vars are undocumented.** `CHECKPOINTS_ENABLED`,
      `DATABASE_DISK_QUOTA_MB`, `LSP_ENABLED`, `LSP_MIN_CONTAINER_MEMORY_MB`
      are accepted by the schema and absent from `apps/server/.env.example`.
      `LSP_ENABLED` is the one that matters — the feature is off by default and
      undiscoverable.
- [ ] **A dashboard list view.** The last open Tier 3 UI item. Cards only; past
      roughly thirty projects a compact list beats scrolling.

### 3.3 Blocked on a decision or on infrastructure

Each is named with what blocks it, so none reads as ready to start.

- [ ] **Custom domains for deployments.** Needs a wildcard DNS record and, over
      HTTPS, a wildcard certificate. Invisible in development because browsers
      resolve every `*.localhost` to loopback themselves; absolute in
      production. Infrastructure, not code.
- [ ] **Process snapshots.** `warmStart.ts` skips the redundant install, so what
      remains is the dev server process, which still dies with its container.
      Resuming a running process is a mechanism nothing here resembles, and it
      needs a decision about how much disk a suspended project may hold. The
      last thing CodeSandbox does that this does not.
- [ ] **Autoscale and scheduled jobs.** A different product with a different
      cost model. Always-on compute exists in its smallest useful form; scaling
      it is a separate decision, not an extension of that work.
- [ ] **Follow-mode with viewport sync.** Following a *file* shipped in ledger
      row 13. Riding someone's scroll position needs cursor positions and scroll
      sync — a new feature rather than a display of what already exists.
- [ ] **Debugging.** Deferred on purpose — see §6, decision 1 — and listed
      here so its absence is visible rather than forgotten. If
      debugging becomes the deciding feature, the answer is Route A
      (openvscode-server), **not** a hand-built debug adapter client — and Route
      A puts the multiplayer layer, the assistant, the run control and the
      preview behind a rewrite. Revisit the route, not the row.

Also deliberately out of scope, recorded so nobody re-opens them by accident:
a CLI and local sync; GitLab and Bitbucket; monorepo sub-directory imports; a
Mongo *sidecar* (row 7b shipped the client; §6 records why the engine stays
Postgres); the user's own VS Code extensions, which Monaco cannot reach at all.

### 3.4 Documentation debts

Two debts that were open this morning are closed by the consolidation rather
than by any work: `REPLIT_CLONE_PLAN` §8.6 listed follow-mode and checkpoint
history as missing when both had shipped, and §8.5 named a `forkProjectService`
module that does not exist (the function lives in `service/projectService.ts`).
The document that was wrong is gone. The lesson it taught is §7.

- [ ] **`monacoSetup.test.ts` asserts on source text** rather than behaviour.
      The last item from the 2026-08-22 list never actioned. The reason it
      matters was demonstrated twice on 2026-08-28: the nginx CSP bug and the
      `sh -lc` PATH bug were both invisible to source-reading checks and both
      caught only by running the real thing. It should become an assertion in
      `apps/web/e2e` — which is also §3.2's E2E-in-CI item, and the two are
      worth doing together.
- [ ] **The `rc_test` database is undocumented.** `CONTRIBUTING.md` mentions
      `TEST_DATABASE_URL` and says the suites skip without it, but never says
      the database exists or how to make one. The next person sees 149 silently
      skipped tests and no reason.

Not a debt but worth recording: **two `Project` rows have no working tree**
("P" and "site", created 2026-08-27). Reported 2026-08-28 and deliberately left
alone — deleting rows and recreating trees are both judgment calls belonging to
whoever owns the data, not to a cleanup script.

---

## 4. Recommended order

1. ~~**§3.1's first three defects.**~~ Done 2026-08-29.
2. **§3.2 E2E in CI**, with the `monacoSetup` debt folded in. It is the
   cheapest way to stop shipping the class of bug the notes keep describing as
   "only a real run could have caught it".
3. **§3.2 language servers.** The cheapest remaining *feature*, and unblocked
   twice over now that the container default is 2048 MB.
4. **§3.1 abuse handling** — before any deployment that is both public and
   multi-tenant, and not before that.
5. **§3.4 the two remaining debts**, whenever they are cheaper than the
   confusion they cause.
6. **§3.2 env vars and the dashboard list view**, which are both an afternoon.

Everything in §3.3 is blocked on a decision or on infrastructure and should not
be started until that decision is made.

---

## 5. What was verified for this document

Claims here were checked against the source rather than carried over on trust.
Specifically:

- `deploymentState` read the row and returned — **no reconcile**. Fixed.
- `assertServiceBudget(subdomain)` took no user and counted host-wide. Fixed.
- `LANGUAGE_SERVERS` has one key, `python`. Confirmed open.
- `checkpointService.ts` and `PresenceStack.tsx`'s follow affordance both exist
  — so the old §8.6's claim that they were missing was confirmed **stale**, and
  the document making it has since been deleted.
- `monacoSetup.test.ts` still reads its own source with `readFileSync`. Confirmed open.
- `.env.example` against the env schema — four keys missing, listed above.
- `ci.yml` — no playwright, no `e2e`. Confirmed open.
- `CONTRIBUTING.md` mentions `TEST_DATABASE_URL` once and never says how to
  create the database. Confirmed open.
- Every file named as a deliverable in §2 exists, bar `forkProjectService.ts`,
  which the old plan invented; `forkProject` is in `service/projectService.ts`.

Not verified, and flagged rather than assumed: the two `Project` rows without
working trees are carried over as reported on 2026-08-28 and were not re-checked
against the database.

---

## 6. Decisions that stand

Carried forward from the deleted documents, because each of these was argued out
once and should not be argued again by accident. Each names what would change
it; nothing else here is a standing decision.

1. **Keep building on Monaco, not on openvscode-server.** Route A gives
   extensions, debugging and language servers for free because it *is* VS Code —
   and puts the multiplayer layer, the assistant, the run control and the preview
   behind a rewrite, since those are exactly what VS Code does not have.
   *Changes it:* debugging becoming the reason people choose something else, or
   running the user's own extensions becoming a requirement. Monaco cannot reach
   the second at all.

2. **A hand-written JSON-RPC client rather than `monaco-languageclient`.** That
   library pins peer versions of Monaco and of the vscode shim, so adopting it
   lets it decide which Monaco this app runs — for what is today a diagnostics
   push and a few provider registrations. *Changes it:* the language surface
   growing past diagnostics, completion and hover. `lib/lspClient.ts` is the seam.

3. **Refuse a language server below 1024 MB of container memory, and say so.**
   `CONTAINER_MEMORY_MB` defaults to 512 and pyright idles at 150–300 MB, so an
   unconditional start has the server and the app competing for the same half
   gigabyte — and an OOM-killed dev server is far worse than an editor saying
   "not enough memory for Python intelligence here". Ships behind `LSP_ENABLED`,
   default off, because the image cost is paid by every cold start including for
   people who never open a `.py` file. *Changes it:* per-project memory limits,
   which would make the threshold a fraction rather than a constant.

4. **A managed database counts as a full container against both caps, and
   `MAX_CONCURRENT_CONTAINERS` stays at 3.** A `postgres:17-alpine` sidecar idles
   at 30–50 MB, so the memory cost is small — but a slot is not only memory, and
   not counting them would silently double the effective cap on a VM whose
   defaults were chosen for three. Raising the cap to 6 to compensate would be
   deciding, on no evidence, that every project is database-backed. *Changes it:*
   numbers from real use — if most projects are database-backed, the pair is the
   natural unit and the caps should count pairs.

5. **Map file icons to `react-icons` glyphs rather than vendoring an SVG set.**
   The mapping is the work, not the drawing; `react-icons` is already a
   dependency and covers every language in the table, without ~1,000 SVGs, a
   sprite step and a licensing decision. *Changes it:* wanting per-file-type
   glyphs no brand icon covers. `FileType.icon` is one field.

6. **Check every Mongo host, but do not pin the address for the driver to
   dial** — unlike the Postgres path, where pinning is used. The two defences are
   mutually exclusive for Mongo: `mongodb+srv://` hostnames usually have no A
   record, and TLS certificates are issued for hostnames, so handing the driver
   an IP fails verification. Dropping TLS to gain pinning trades a narrow rebind
   window for plaintext credentials on the wire. *Changes it:* a driver hook
   reporting the address actually dialled.

7. **A GitHub token is spent where the existing rule already says.** At rest,
   AES-256-GCM under a server key in a row of its own — never in the project,
   never in `.git/config`, never in a remote URL. Server-side use decrypts in
   memory for one call. Container-side use (clone, push) only when the project
   has no collaborators and no outstanding share link, passed in the exec's
   **environment** and never its arguments, because process arguments are
   world-readable through `/proc`. Two consents, not one: signing in keeps
   `read:user user:email`, and reaching repositories is a separate step.
   Disconnecting deletes the row rather than flagging it.

8. **Clones run inside a container, and import URLs are built by the server**
   from an `owner/repo` the GitHub API returned. A user-supplied URL string is
   never cloned, which removes the `ext::`-transport question rather than
   answering it.

9. **Hunk staging needs a patch editor, and half of one is worse than none** —
   the reasoning that deferred it through two plans. It shipped once there was
   one.

10. **Deploying user apps needed a third origin.** A published site is arbitrary
    user code, so it must not be same-origin with the API — and less obviously
    must not share the *preview* origin either, since a preview is authenticated
    by a cookie scoped to that origin.

---

## 7. How to keep this file true

**Update the line in the same commit as the work it describes.** A ledger
updated separately is a ledger that will eventually disagree with the tree —
which is precisely how the old plan came to list two shipped features as
missing, and how this file came to exist. It is the only rule here, and the
consolidation buys nothing if it is not followed.
