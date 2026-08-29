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
| `pnpm --filter server test` | **1397 passing**, 149 skipped (83 files) |
| `pnpm --filter web test` | **858 passing** (64 files) |
| Debt scan (`TODO`/`FIXME`/`HACK` over `apps/`, `packages/`) | **0 hits** |

The 149 skipped server tests are the DB-gated suites (`TEST_DATABASE_URL`
unset) and the shell-quoting round-trips (`/bin/bash` absent on Windows). Both
run in CI.

**Done: 71 items. Open: 6.** All six are blocked on a decision or on
infrastructure — five in §3.3, plus report-and-review in §3.1, which needs
somebody to decide who moderates. **Nothing on this page is unblocked.** The
one item that was — the dangling section references found by the 2026-08-29
audit — was closed the same day (§2.9), which is what empties this list of
work anybody could simply pick up.

Everything in §2 was re-verified against the source on 2026-08-29 rather than
carried forward on trust. Three claims did not survive it — see §5.

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
- [x] **Always-on deployments** — the six templates that serve from a process get a long-lived container of their own, budgeted by `MAX_DEPLOYED_SERVICES` and, since §2.8, `MAX_DEPLOYED_SERVICES_PER_USER`
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
- [x] 12 — language servers behind `LSP_ENABLED`; Python first, Go since (§2.8)
- [x] 13 — checkpoint history, then follow mode

### 2.7 GitHub workflow (`GITHUB_WORKFLOW_PLAN` §5)

- [x] 1 — keep the connection (AES-256-GCM under `SECRET_ENCRYPTION_KEY`)
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
- [x] **The end-to-end flows run in CI.** A job of its own: Postgres service,
      `sandbox-node` built, migrations applied, the API and the built web app
      started and health-waited, then Playwright against the real stack.
      `E2E_REQUIRE=1` turns the suite's quiet skip into a hard failure, because
      a job that skips all four specs and reports green claims the real stack
      was exercised when nothing was.
- [x] **`monacoSetup.test.ts` asserts on behaviour.** The white-editor guard is
      now an assertion in `playground-flow.spec.ts` that reads the computed
      background off a real Monaco instance. The source-text greps it replaced
      are deleted; what stays is the theme polarity (data, not source) and the
      three editors the browser flow never opens.
- [x] **Language servers work, and there are two of them.** Go joins Python.
      This was listed as "a registry entry and an image that carries it" and
      was not: the gateway exec'd with `WorkingDir: "/app"`, which exists in
      none of the sandbox images, so Docker refused to start the process and
      **no language server had ever run**. Invisible because the feature ships
      behind `LSP_ENABLED`, default off. Three further gaps behind it: `pylsp`
      was not installed in the Python image at all; a bare `python-lsp-server`
      publishes an empty diagnostics list because the checkers are separate
      packages; and `LspClient` was complete but no component ever constructed
      one, so nothing on the page would have connected. All four fixed, and
      both servers verified against real containers — `pylsp` reporting an
      undefined name and an unused import, `gopls` reporting an undefined
      symbol and an unused variable, at the right lines and severities.
- [x] **A language its container cannot serve is refused with a sentence.**
      `LANGUAGE_SERVERS[…].image` was declared and never read, so a `.py` file
      opened in a Node project reached `exec` and failed with "executable file
      not found" mid-handshake. Checked up front now.
- [x] **Every env var the schema accepts is in `.env.example`** — 41 of 41,
      audited rather than eyeballed. The four that were missing included
      `LSP_ENABLED`, which is how the feature above stayed undiscoverable.
- [x] **The test database is documented**, with commands verified by running
      them. `CONTRIBUTING.md` said the DB-backed suites skip without
      `TEST_DATABASE_URL` and never said the database existed or how to make
      one — so the next person saw 149 silent skips and no reason. It also
      still claimed CI does not run E2E, which stopped being true an hour
      earlier; both fixed together.
- [x] **A dashboard list view.** The last open Tier 3 UI item. A segmented
      toggle beside the sort, remembered per browser in `localStorage` and
      wrapped in try/catch on both sides — a private window makes the accessor
      itself throw, and failing to render a dashboard over a display preference
      would be the worst possible trade. The action menu was extracted into one
      `ProjectActions` shared by both layouts: two copies of a menu whose
      entries depend on ownership is exactly the pair that drifts.
- [x] **Publishing a project is rate limited.** Forking was, as project
      creation; publishing never was, and publishing is the action on that
      route whose cost lands on people other than the person taking it.
      Limited **in one direction only** — making a project private is never
      rationed, because that is the remedy for having published it, and the
      person most likely to be at their limit is the person who has been
      publishing.

---

### 2.9 Since (2026-08-29, later)

- [x] **The dangling section references are gone.** Every code comment
      citing a planning document deleted by the consolidation now either names
      `docs/ROADMAP.md` and a section that exists, or carries the argument
      itself. Of 47 sites, only **seven** became a pointer — six at §6
      (`§7.4`→decision 4 twice, `§10.4`→decision 6, `§3.3`→decision 3 twice,
      `§3.2`→decision 2) and the schema's Mongo note at §3.3. The other 40 had
      no home in §6 and did not need one: they were comments appealing to a
      section for authority while already stating the reason a line below, so
      the citation came out and the reasoning stayed. That is the part the
      debt entry got wrong: it assumed most would renumber, and most instead
      turned out to be load-bearing prose wearing a footnote.

      One correction to the debt entry itself: it said **none** of the 45
      resolved, "checked, not assumed". One did — `lspPolicy.test.ts` already
      cited §6, decision 3, and was left untouched here. So 44 were dangling,
      not 45.

      Three further references the audit missed, because it searched only
      `apps/*/src`: two in `prisma/schema.prisma` (one of them a prose
      reference to "row 7b of the parity plan" rather than a `§`) and one in
      `githubService.ts` ("noted in the plan"). Counting only `§`, and only
      under `src`, is what hid them.

- [x] **`schema.prisma` was mojibake in nine places and nobody had noticed.**
      Found while editing a comment there: eight em-dashes and one `§` were
      double-encoded — UTF-8 bytes read once as cp1252 and written back — so
      the file said `â€”` and `Â§` in its own source. Repaired, and the rest of
      the repository scanned with the same signature to confirm it was the only
      file affected. It reaches further than it looks: `prisma generate` copies
      these comments verbatim into the generated client, so every regeneration
      reproduced them.

---

## 3. Open

### 3.1 Defects — code that is merged and wrong

The three deployment defects listed here were fixed on 2026-08-29 and have
moved to §2.8, along with the rate-limiting third of the item below. What is
left is not a defect any more so much as an unmade decision.

- [ ] **Public projects have no report mechanism and no review.** The third
      part of this — no rate limit on *publishing* — was closed on 2026-08-29
      (§2.8). The two that remain are a **product decision, not a task**: they
      need somebody to review reports and an authority to act on them, and this
      app has no notion of an administrator to hang either on. Single-tenant
      and invite-only deployments are unaffected. A public multi-tenant one
      needs both before `visibility = PUBLIC` is safe to expose, and deciding
      who moderates comes first.

### 3.2 Unblocked — work, not decisions

Empty. Every item that was here on 2026-08-29 is now in §2.8.


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

All four debts once on this list are closed, and the audit of 2026-08-29 found
a fifth that nobody had recorded. Two of the four went with the
consolidation rather than with any work: `REPLIT_CLONE_PLAN` §8.6 listed
follow-mode and checkpoint history as missing when both had shipped, and §8.5
named a `forkProjectService` module that does not exist (the function lives in
`service/projectService.ts`). The document that was wrong is gone; the lesson
it taught is §7. The third, `monacoSetup.test.ts` asserting on its own source
text, was closed by giving it a real browser to assert against. The fourth, an
undocumented test database, is now a section of `CONTRIBUTING.md` with the
commands verified by running them — §2.8 for all three.

The fifth debt, the dangling section references, was closed on 2026-08-29 —
§2.9. Nothing is open in this section.


Not a debt but worth recording: **two `Project` rows have no working tree**
("P" and "site", created 2026-08-27). Reported 2026-08-28 and deliberately left
alone — deleting rows and recreating trees are both judgment calls belonging to
whoever owns the data, not to a cleanup script.

---

## 4. Recommended order

1. ~~**§3.1's first three defects.**~~ Done 2026-08-29.
2. ~~**§3.2 E2E in CI**, with the `monacoSetup` debt folded in.~~ Done
   2026-08-29.
3. ~~**§3.2 language servers.**~~ Done 2026-08-29 — and it was not cheap,
   because nothing underneath it had ever run.
4. **§3.1 report and review** — before any deployment that is both public and
   multi-tenant, and not before that. Decide who moderates first; the rate
   limit that needed no such decision is done.
5. ~~**§3.4 the remaining debts**.~~ Done 2026-08-29.
6. ~~**§3.2 env vars and the dashboard list view**.~~ Done 2026-08-29.

7. ~~**§3.4 the dangling section references.**~~ Done 2026-08-29, and it was
   worth doing while §6 was fresh — though §6 turned out to be the right home
   for only six of them.

Everything in §3.3 is blocked on a decision or on infrastructure and should not
be started until that decision is made. Item 4 needs a decision before it needs
a developer. **There is nothing left on this page to simply start.**

---

## 5. What was verified for this document

Claims here were checked against the source rather than carried over on trust.
Specifically:

- `deploymentState` read the row and returned — **no reconcile**. Fixed.
- `assertServiceBudget(subdomain)` took no user and counted host-wide. Fixed.
- `LANGUAGE_SERVERS` had one key, `python`. Fixed — and the mechanism under
  it had never started a process, which reading the registry alone did not
  show. Found by exec'ing the gateway's own options against a real container.
- `checkpointService.ts` and `PresenceStack.tsx`'s follow affordance both exist
  — so the old §8.6's claim that they were missing was confirmed **stale**, and
  the document making it has since been deleted.
- Every file named as a deliverable in §2 exists, bar `forkProjectService.ts`,
  which the old plan invented; `forkProject` is in `service/projectService.ts`.

**Verified 2026-08-29**, having been carried as unverified since 2026-08-28:
the two `Project` rows without working trees are real. Twenty rows in the
database, eighteen directories under `PROJECTS_DIR`, and the two with no tree
are exactly "P" and "site" (created 2026-08-27) as reported. There are **no
orphan directories** in the other direction. Still deliberately left alone:
deleting rows and recreating trees are judgment calls belonging to whoever owns
the data.

### What the 2026-08-29 audit changed

Every claim above was re-checked against the source rather than re-read. All
seven commit hashes in §2.1 resolve and match their subjects; the headline
numbers reproduce exactly; every file and symbol named as a deliverable in §2
exists; and every item in §3.1 and §3.3 is genuinely absent, including the
follow-mode blocker — the awareness transport carries a name and a colour and
no cursor position, so "needs cursor positions and scroll sync" is accurate.

Three claims were wrong and are corrected above:

- **`GITHUB_TOKEN_KEY` does not exist.** §2.7 named it as the key the GitHub
  token is encrypted under. The code uses `SECRET_ENCRYPTION_KEY`, and the
  invented name appeared in exactly one place in the entire repository: this
  file. Someone configuring GitHub integration from the roadmap would have set
  a variable nothing reads.
- **§6 decision 3 was argued from pyright**, which is not what shipped. See the
  correction there.
- **§3.4 said "nothing is open here"** while 45 dangling section references sat
  in the code. Now recorded as the debt it is.

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
   `CONTAINER_MEMORY_MB` defaults to 512 and a language server idles in the low
   hundreds of MB, so an unconditional start has the server and the app
   competing for the same half gigabyte — and an OOM-killed dev server is far
   worse than an editor saying "not enough memory for Python intelligence here".
   Ships behind `LSP_ENABLED`, default off, because the image cost is paid by
   every cold start including for people who never open a `.py` file.
   *Changes it:* per-project memory limits, which would make the threshold a
   fraction rather than a constant.

   *Corrected 2026-08-29.* This decision was argued from **pyright**, which
   pulls Node into the Python image. The implementation is `pylsp`, which is
   pure Python, and the cost was measured rather than assumed: sandbox-python
   307 MB → 338 MB, sandbox-go 1.31 GB → 1.36 GB for `gopls`. The threshold
   still stands — the idle figure is what it turns on, not the image size —
   but the number it was argued from was never checked.

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
