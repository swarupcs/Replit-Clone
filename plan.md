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

Verified by running it rather than reading about it. The numbers are as of
2026-08-31 (night); the notes under the table say which rows were **not**
re-run that day, and why that matters more than usual:

| Check | Result |
|---|---|
| `pnpm -r typecheck` | clean, 3/3 packages |
| `pnpm --filter server test` | **1656 passing**, 280 skipped (122 files) — no database on this machine |
| the same, with `TEST_DATABASE_URL` set | last green 2026-08-31 evening, four times. **Not re-run since §2.22**, which adds six migrations — see §5 |
| `pnpm --filter web test` | **1051 passing** (82 files) |
| `pnpm -r lint` | clean, 3/3 packages — first time; see §2.21 |
| Debt scan (`TODO`/`FIXME`/`HACK` over `apps/`, `packages/`) | **0 hits** over ~51k lines |

The skipped server tests are the DB-gated suites (`TEST_DATABASE_URL` unset)
and the shell-quoting round-trips (`/bin/bash` absent on Windows). Both run in
CI. The count in that row is what remains skipped **with** the database
configured; without it the figure is an order of magnitude larger, which is
why the two rows are listed separately rather than as one number that would
mean different things on different machines.

The DB-gated row was run rather than quoted for §2.11 and §2.12:
both put load-bearing claims in a unique index, a foreign key and a
transaction, and a mock cannot be wrong about those in any way worth trusting.

**The debt recorded here against §2.13 and §2.14 is now cleared**, and
clearing it was not a formality. Docker came back on the evening of
2026-08-30, the suite ran, and it failed 12 tests across two files. Every one
of them was real:

- **§2.14's 11 DB-gated tests could not connect at all.** The file imported
  `config/env.ts` at its top, and that module parses `process.env` once on
  first import while `setupEnv.ts` seeds a dummy `DATABASE_URL` so importing
  it never fails. So the dummy was frozen in before `beforeAll` could put the
  real URL in place, and every query authenticated as `test`. The suites that
  pass all import it lazily. A test that has never been run is not a test, and
  this one had been carried for a day as though it were evidence.
- **§2.13's `updateJob` was not scoped to its project** — found by the one
  DB-gated schedule test that had never run. See §2.15.

With those fixed the whole suite is green against a live database, which also
means §2.13's hand-written migration has now been applied and exercised rather
than only read.

Two flakes are worth knowing about, since both will otherwise be mistaken for
regressions:

- Under load the **web** suite fails 9–10 at the default 5s timeout, always
  the *first* test in a file and always passing in isolation. Verified as
  environmental by running it on a clean checkout, which failed the same way.
  `--testTimeout=20000` is green at 74/74.
- The server suite occasionally dies with `ERR_IPC_CHANNEL_CLOSED` / "Channel
  closed" from tinypool, reporting no test failures at all. Seen three times
  on 2026-08-31. It is the worker pool, not the tests: the next run passes.
  **Not investigated.**
- `refreshTokenService.test.ts` — "lets exactly one of several concurrent
  refreshes claim the row" — fails under load roughly one run in three, with
  "Session was reused and has been revoked". It is timing against a reuse
  grace window. Passes 3/3 in isolation, and the file has not been touched
  since well before it was first seen. **Not investigated**, and recorded here
  rather than left to be rediscovered.

**Five of §8's seven items shipped the night it was written** — §2.22 to
§2.25, with §5 for the claim in them that is not verified. §8 is the product
around the platform rather than another thing wrong with the platform, which is
why it is a section of its own; it is counted in the totals below like
everything else.

**Done: 113 items. Open: 8 — three of them unblocked.**

Open, in full, so the shape is visible without scrolling: **no defects**
(§3.1 is empty again, and read the paragraph at the top of it before believing
that), **no unblocked work in §3.2**, **three halves §9 split out and gave an
order** (a compute meter, a hostname endpoint for a TLS terminator, and billing
state without a processor), and **five blocked** (§3.3 — a certificate, an autoscaler's
cost model, a disk budget for snapshots, a backup destination, and an
architectural route). §8.4 and §8.5 are blocked too, on a Stripe account and on
a pricing decision respectively, and are listed there rather than duplicated
here.

**§9 was written on 2026-09-01 and takes four of the five apart** — not by
finding new work, but by asking of each blocked row which half needs a person
and which half is only code nobody wrote. A recoverable delete, a compute
meter, a hostname endpoint for a TLS terminator, and billing state without a
processor are all buildable today. Read it before believing the five below are
each one thing.

Seven items came off in three commits (§2.26–§2.28), which is what a sweep's
findings look like once they are worked through rather than what they looked
like when they arrived. **Nothing unblocked left is the state this file has
been in five times, and it has been wrong every time** — §4's closing paragraph
is the standing warning, and §3.1's opening paragraph is the sharper one: an
empty defect list means nobody has looked lately, never that the code is right.
The next entry in §2 will almost certainly come from reading two shipped things
against each other, as the last eleven did.

**These two numbers had drifted, and the drift is worth a sentence** because
this file's one rule (§7) is that a line is updated in the commit that changes
it. They last read "Done: 90. Open: 4 — all four blocked", which was true
before the 2026-08-31 sweep and stayed on the page through nine new items and
five shipped ones. Every individual entry was updated correctly in its own
commit; the *summary of them* was not, because no single commit was obviously
the one that owned it. That is the failure mode §7 does not currently cover:
a derived figure belongs to whoever last invalidated it, and here that was five
different commits in a row, each of which could reasonably think it was not
the one.

**§3.2 is no longer empty, and that is the substantive change here.** It held
nothing from 2026-08-29 until now, which this document read as "there is
nothing left to simply start" — see §4, where that claim is made and has now
been wrong five times. What had actually happened is that the page stopped
being where work was found. The four items that arrived in §3.2 came from
reading the shipped features against each other rather than from any list, and
none of them was blocked on anything. The first of them shipped the same day
(§2.15); three remain.

A pattern is now firm enough to state. **Building a thing that watches an
existing feature finds defects in the feature it watches.** Notifications
turned up two, neither of which anybody was looking for: a `withTimeout` that
reported a crashed exec as a timeout, and an `updateJob` that never checked
which project a job belonged to. Both had been merged, reviewed and passing
for a day. Nothing makes a wrong state as visible as deciding to tell somebody
about it.

The related one, from §2.16: **a remedy is not a mechanism.** Moderation's
ACTIONED was written as `visibility: PRIVATE` — a column this codebase
documents as the owner's own switch — and so the takedown left the site
serving, left the embed resolving, and could be undone by the person it was
applied to. Every piece of what it needed already existed. Nobody had asked
what the action actually reached, because the queue looked finished from the
moderator's end: the button worked, the row changed, the page updated.

The two newest done items (§2.14) came from neither §3 nor anybody's feature
list. They came from reading the schema next to itself: three columns holding
secrets were sealed and a fourth was not, and the endpoint that reads that
fourth one draws an access line that another endpoint quietly crossed. Both
were found by asking what this code already believes and where it stops
believing it — which is a way of finding work that a list of open items does
not produce.

Two rows have now come off this list by being *split* rather than unblocked
(§2.12, §2.13), which is the pattern worth naming. Both read as blocked
because they bundled something genuinely outside this repository with
something that was only ever code: a certificate with the domain plumbing, an
autoscaler's pricing decision with a cron table. Neither half needed the
other. Before concluding a row is blocked, check whether it is one thing.

Three items have left the open list since the 2026-08-29 audit, and they did
not leave it the same way. Two were never blocked: the dangling section
references (§2.9), and follow-mode's viewport sync (§2.10), which was recorded
as waiting on cursor positions that had been on the wire the whole time.
Report-and-review (§2.11) genuinely was blocked, on a decision about who
moderates — and it was closed by *making* that decision, not by finding it had
already been made. The difference is worth keeping: an unmade decision reads
like infrastructure on a list like this one, and it is not. Nobody can conjure
a wildcard certificate, and one person can settle who moderates in an
afternoon.

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

### 2.10 Since (2026-08-29, later still)

- [x] **Other people's cursors are visible.** They were never missing from the
      wire. `MonacoBinding` has published every local selection into awareness
      and decorated every remote one since collaborative editing shipped,
      tagging each decoration `yRemoteSelection-<clientID>` — a class per
      person, so that colours can differ. y-monaco ships no stylesheet for
      those classes and there was none here either, so every remote selection
      rendered as an unstyled span: present in the DOM, invisible on screen.

      `lib/remoteCursors.ts` generates the rules, which have to be generated
      rather than written once because the class name carries a client id known
      only at runtime. Selections are tinted rather than filled — the code
      underneath still has to be readable — and each caret is labelled, because
      with four people in a file colour alone stops answering the question
      anyone actually has.

      The colour and the name are interpolated into a stylesheet and both
      arrive from another client, so both are checked: colours are *matched*
      against the forms this app produces rather than escaped, and anything
      else falls back to the colour derived from the person's name. A peer
      whose colour was `red; } body { display: none } .x {` would otherwise
      have been writing CSS into everybody else's page.

- [x] **Follow mode rides the viewport, not just the file.** Awareness now
      carries a `viewport` — the visible line range, per document, because
      somebody in two files is scrolled to two places. No server change: the
      awareness relay is opaque bytes and always was.

      Scoped to follow mode on purpose. The argument against doing this,
      recorded when following shipped, was that yanking somebody's viewport
      around is motion sickness rather than collaboration — and that argument
      still holds for everyone who has not asked. Following is a button
      somebody pressed. It is a request to be moved.

      Two things that are easy to get wrong and were: publishing is skipped
      when the visible *lines* have not changed, or a flick-scroll puts a
      packet on the socket every frame; and a scroll caused by following is
      not republished as though it were ours, or two people following each
      other push one another back and forth forever. The second guard began as
      a flag cleared on a timer and that was a race — `setScrollTop` does not
      promise when its event arrives. It matches the expected line instead,
      and gives that line up as soon as any scroll lands anywhere else, since
      Monaco cannot always scroll as far as it is asked to.

- [x] **A correction to the audit.** §5 said the awareness transport "carries a
      name and a colour and no cursor position", and used that to confirm §3.3's
      blocker. Both halves were wrong. y-monaco puts a `selection` on the wire
      and has all along; what was missing was any CSS to draw it. The audit
      searched this repository's own code for cursor handling and found none,
      which was true and not the question — the code doing it was in a
      dependency. Checking what a library already does, not only what the
      application does, is the lesson.

---

### 2.11 Since (2026-08-30)

- [x] **Public projects can be reported, and the reports have somewhere to
      go.** The last item in §3.1, and the only thing on this page blocked on a
      decision anybody here could make. The decision is §6, decision 11: an
      `ADMIN_EMAILS` allowlist rather than a role column on `User`. A role
      column needs a way to appoint the *first* admin, which is its own
      bootstrapping problem and ends in an environment variable anyway — so the
      environment variable is the whole design rather than the scaffolding for
      it.

      Empty by default, and an empty allowlist means **nobody**. Stated as its
      own branch in `isAdminEmail` rather than left to `Set.has` on an empty
      set, because the bug it prevents — an unconfigured deployment handing the
      report queue to every account that signed up — is one worth being unable
      to introduce by accident.

      The authority granted is the smallest one that resolves a complaint: an
      operator can make a project private. They cannot delete it, edit it, or
      touch the owner's account. That is the only power whose mistakes are
      undoable by the person they were made against.

      Three refusals on the reporting side, each for its own reason. A project
      that is not public has no audience to protect — and answers identically
      to one that does not exist, so the endpoint cannot be used to ask whether
      a private project is there. A project you own is one you can make private
      yourself, which is never rate limited. And a second report from the same
      account is the same complaint again, refused by a unique index rather
      than by a check, because the check is the one that loses a race.

      Rate limited at ten an hour on top of that index. The index stops one
      project being reported twice by one person; the limiter stops a hundred
      *different* projects being reported in a minute. What is scarce here is
      an operator's attention, not a database.

      `ACTIONED` closes every other open report on the same project in the same
      transaction. Without it a project nine people objected to sits in the
      queue eight more times after it is already private, and the operator
      working through it decides the same case repeatedly with no way to see
      that it is the same case. A `DISMISSED` speaks only for its own report:
      two people can object for different reasons, and finding one baseless
      says nothing about the other.

      Reports outlive their reporters — `SetNull` rather than `Cascade` —
      because deleting an account must not quietly withdraw a complaint nobody
      has acted on yet. The report stays and stops naming anybody.

      The queue's route is not hidden from non-admins on the client; only the
      link to it is. That asymmetry is the point. Hiding a route is a check
      that looks like access control while enforcing nothing, so the server
      checks the allowlist on every request and the client decides only whether
      to *offer* the page. `PublicUser.isAdmin` is a hint for the interface: a
      client that sets it true for itself gets a link to a page that answers
      403.

      Counters for all three transitions, because the failure mode a report
      mechanism actually has is not being wrong — it is nobody reading it.
      `project_reported` climbing while `report_actioned` and
      `report_dismissed` stay flat is that failure, made visible.

---

### 2.12 Since (2026-08-30, later)

- [x] **A project can be served at a domain its owner controls.** The code
      half of §3.3's first row, which turned out to be most of it.

      Every other address in this product is generated, and therefore trusted
      by construction — the server made the name up, so nobody else has a
      claim on it. A custom domain inverts that: the user supplies a name the
      server has no reason to believe they own, and a server that believes
      them anyway will serve one person's code at another person's address.
      That is not a bug in a deployment, it is a phishing site with a valid
      certificate.

      So the whole design is one sentence: **a claim is not an address.** The
      domain is stored the moment it is claimed, because the TXT record
      somebody has to publish cannot be shown to them before the server has
      generated it — and it is served only once that record has been seen.
      `resolveSite` reads `domainVerifiedAt`, never `customDomain` alone, and
      the check is in the WHERE clause rather than in a branch above it so
      that there is no version of the function that forgets.

      Claimed names are refused if they belong to the platform: the API
      hostname, the web origin, and anything under the deploy origin's suffix,
      which is handed out as generated subdomains on the assumption that
      nothing else can occupy it. Two projects cannot hold one name, and that
      is the unique index rather than a read before the write — the same race
      as the report queue, with the same 409 rather than a 500 for the loser.

      Re-claiming a domain rolls the token and clears the verification.
      Otherwise re-claiming is a way to move a verified name onto a new token
      without proving anything about it.

      **Verification is re-checked daily, and this is the part that is easy to
      leave out.** A domain can be sold. A verification believed forever means
      the seller keeps an address they no longer control and the buyer's
      visitors land on the seller's code. The sweep clears the verification
      when the record is gone — the site stops answering at that name — but it
      keeps the claim and the token, so an owner who broke their own DNS fixes
      the record and presses verify rather than discovering the platform gave
      their name away.

      What is **not** here is a certificate. Over plain HTTP a verified domain
      works the moment DNS points at the deploy listener. Over HTTPS the
      operator needs a certificate for that name, which is ACME's job and a
      deployment decision — §3.3 now says that and only that.

---

### 2.13 Since (2026-08-30, later still)

- [x] **A project can run a command on a schedule.** The half of §3.3's
      "autoscale and scheduled jobs" that never needed a cost model. Deciding
      how much compute to *buy* is a pricing question; deciding when to use the
      compute that already exists is not, and the two were on one line.

      Cron is parsed here rather than by a library — `lib/cron.ts` — for the
      reason §6 decision 2 gives about the language client: a scheduler needs
      exactly one thing from cron, "given this expression and this instant,
      what is the next instant", and every library that answers it also brings
      a timezone database, a job runner and an opinion about storage.
      Everything is **UTC**, which is a promise this can keep; local time is
      one it cannot, since a daylight-saving boundary turns "02:30 daily" into
      a day with two of them and a day with none.

      The dialect is deliberately small: `*`, `n`, `a-b`, steps, lists, and the
      `@daily` shorthands. `L`, `W`, `#` and named months are refused rather
      than half-implemented, because each is a dialect rather than cron and
      accepting one silently means an expression whose meaning depends on which
      library read it.

      Four decisions carry the rest:

      **The next firing is stored, not derived.** The sweeper is one indexed
      query on `(enabled, nextRunAt)` rather than a scan that parses every
      expression on the machine every minute.

      **A missed window fires once, not once per miss.** A server down for a
      day owes an hourly job twenty-four runs by the calendar, and running them
      is never what anybody wanted — twenty-four backups at once, or
      twenty-four identical emails.

      **Overlap is recorded, not queued.** A firing that finds the previous run
      still going is written `SKIPPED`. A queue would turn a job slower than
      its own schedule into an unbounded backlog, which is the failure that
      takes the machine with it.

      **Six run states, not two.** "It did not run" and "it ran and failed" are
      different problems with different fixes: `SKIPPED` means the schedule is
      too frequent, `TIMED_OUT` means the budget is too small, `ERRORED` means
      it never reached a container. A panel that collapses them into "failed"
      sends people to read the wrong logs — which matters here more than
      anywhere else in the product, because a schedule's failure mode is
      silence and nobody is watching.

      Refused at the moment somebody types it, not in a bill: an expression
      that never fires (`0 0 30 2 *` is valid cron and February has no 30th),
      one that fires more often than every five minutes, and more than ten jobs
      per project. Writing a job is the owner's alone and not an editor's —
      "may edit a file" and "may arrange for a command to run at 3am forever"
      are not the same grant, and the second is the shape of a backdoor if it
      is handed out with the first.

      Autoscaling stays open in §3.3, narrowed to what it always was.

---

### 2.14 Since (2026-08-30, evening)

- [x] **A read-only collaborator could take a copy of a project and get its
      secrets.** Reading `/env` requires **editor** access, on the stated
      grounds that "read-only access to a project is not the same as being
      trusted with its credentials". `duplicateProjectService` was open to a
      **viewer** and copied `envVars` into the new project — which the viewer
      then owned, and could therefore read through the same endpoint that had
      just refused them.

      Forking already got this right and says so in its own test: "the line
      between a fork and a credential leak". Duplicating kept the variables on
      the reasoning that a duplicate is your own copy of your own project, and
      that reasoning is sound for the owner and for an editor. It was never
      checked against who could actually reach the function.

      Now the variables travel only for an editor or the owner. The
      convenience the rule existed for — a copy that can actually run — is
      preserved for everybody who was already entitled to the credentials, and
      the copy is empty for everybody who was not.

- [x] **Environment variables are encrypted at rest.** This column is where
      people put `STRIPE_SECRET_KEY`, and it was the last secret in the schema
      stored in the clear: the GitHub token, the stored connection string and
      the managed database's password have all been sealed under
      `SECRET_ENCRYPTION_KEY` since they were added, and §6 decision 7 writes
      the rule down. A dump of `projects` was a list of live credentials.

      Values are sealed one at a time rather than as an object, and names stay
      readable. The name is not the secret, the platform validates it against
      `RESERVED`, and an operator debugging a container has to be able to see
      which variables exist — sealing per value keeps that true and means one
      unreadable value costs one variable rather than all of them.

      **Shape decides whether a stored value is ciphertext, not whether `open`
      threw.** This is the part that is easy to get wrong: `open` throws both
      for plain text and for a value sealed under a *different* key, so
      "it threw, therefore it is plain text" would hand the ciphertext back as
      though it were the secret — and a key rotation would quietly start
      feeding containers base64 instead of failing. `looksSealed` answers the
      first question and `open` answers the second.

      The backfill runs once at boot rather than in SQL or on read. SQL cannot
      reach a key that lives in the environment — which is the property that
      makes a leaked dump worthless — and a lazy-on-read migration never
      finishes, because reads do not write and the projects nobody opens are
      exactly the ones nobody is watching.

      A server with no key keeps working, in plain text, and **says so in the
      dialog**. Refusing to save would break every install that never set a
      key for a feature it does not use; looking identical either way would be
      a panel that lies on one of the two servers.

---

### 2.15 Since (2026-08-30, night)

- [x] **The platform tells people things.** The silence in §2.11 and §2.13 is
      closed, and closed the same way for both: a notification is a stored
      **record** first, and mail only if mail happens to work.

      That ordering is forced by this codebase rather than preferred. The
      obvious build — call the mailer where the event happens — fails here,
      because `mailer.ts` falls back to a logging mailer that reports an
      *error* per message in production. An install without SMTP would turn
      every failing job into error spam and still leave its users knowing
      nothing. The row is the feature; the email is a transport that may not
      exist.

      **The rule that carries the rest: notify on the CHANGE, not the state.**
      A job that fails thirty nights running is one piece of news, not thirty.
      The second consecutive failure says nothing and the recovery speaks.
      Mailing every failure is how a notification somebody needed becomes a
      filter rule — which restores the silence this was built to end, and
      hides that it has. The comparison needs no new column: `ScheduledRun`
      history was already kept and pruned.

      `SKIPPED` and `ERRORED` are not verdicts on the command and neither
      starts nor ends a failure. A week of Docker being down must not read as
      a week of the backup being broken.

      **Moderators get mail and no inbox**, because `requireAdmin` identifies
      them by `ADMIN_EMAILS` and a configured address need not have a `User`
      row at all. An empty `ADMIN_EMAILS` warns rather than passing quietly:
      a queue nobody is told about is precisely the condition being fixed, and
      it must not be reachable by leaving a variable unset and hearing nothing.

      Mail goes only to a **verified** address. `emailVerifiedAt` exists
      because signing up does not prove you own what you typed, and somebody
      else's project news is not sent to an address that may not be theirs.
      Nothing in `notify` throws at its caller: a notification is a side effect
      of work that already happened, and failing that work because the
      announcement could not be written would be the tail wagging the dog.

- [x] **`withTimeout` reported a crashed exec as a timeout.** It resolved
      `"timeout"` when the work *rejected*, so an exec that threw — the daemon
      dropping the connection, the container vanishing underneath it — was
      recorded `TIMED_OUT` and told the owner the command "may still be
      running inside the container". It was not running anywhere. `ERRORED`
      was reachable only when `ensureContainer` threw.

      That collapsed exactly the distinction the six run states exist to draw
      (§2.13), and it had been merged and passing for a day. It was invisible
      while nothing acted on the difference; with notifications on, an hour of
      Docker being down mails every owner on the machine to say their job is
      failing — false, and the fastest way to teach people the channel is
      noise. **Found by a test written for the notifier, not for the sweeper.**

- [x] **`updateJob` did not check which project a job belonged to.** It took a
      `projectId` and looked the job up by `id` alone, so an owner of any
      project could edit any job on the machine by guessing its id. The field
      that makes this serious is `command`: the reward was making somebody
      else's container run whatever you liked, on their schedule, under their
      name.

      `deleteJob`, `listRuns` and `runJobController` all scope correctly, and
      the last one carries a comment explaining exactly this risk. The one
      function that did not do it was this one — a single lapse in a careful
      file, which is the kind a reviewer's eye slides over precisely because
      everything around it is right. Found by a DB-gated test from §2.13 that
      had never been run, on the night the database came back.

---

### 2.16 Since (2026-08-30, night, later)

- [x] **A moderator's takedown now takes the project down.** Three things were
      wrong and they were one mistake: ACTIONED was expressed as
      `visibility: PRIVATE`, and that column belongs to the owner.
      `setProjectVisibility` says so in as many words — "a decision about who
      may read the source" — and deliberately leaves the share token, the
      collaborators and the deployment alone.

      That reasoning is correct for somebody toggling their own project. It
      does not survive being borrowed as a remedy against them. A project
      reported for MALWARE went on being **served** at its public deploy URL;
      one reported for SECRETS went on serving its source through its embed
      token, which is precisely the link that would have been pasted around.
      And `setProjectVisibility` checks only ownership, so the owner could
      publish it again in one request. What a moderator actually achieved was
      removing it from the gallery.

      `takenDownAt` is a separate column for that reason: a takedown is a
      different fact from a visibility setting, made by a different person,
      and storing them in one place is what let one overwrite the other.

      **The enforcement is in the WHERE clauses, not in the cleanup.**
      `resolveSite` and the embed's `resolveToken` both filter on
      `takenDownAt: null`, and `unpublish()` and `revokeEmbed()` are called
      afterwards to reclaim the files, the container and the row. That order
      matters: the teardown touches Docker and the filesystem, so it can fail
      in ways a database cannot, and a takedown that only holds when the
      cleanup succeeded is a takedown that usually works. Same lesson as
      `resolveCustomDomain` in §2.12 — put the condition in the query.

      Only re-publishing is refused, not going private. A moderator wanting a
      project non-public cannot object to the owner making it more so, and the
      alternative has a failure mode that reads "you may not make your own
      project private".

      Both halves already existed as functions. Moderation called neither.

---

### 2.17 Since (2026-08-31)

- [x] **Moderation keeps a record, and a takedown can be appealed.** Both in
      one table and one commit, because they are one conversation and only
      read in order: taken down, appealed, reinstated. Two tables would have
      been two halves of it.

      The trail records who acted, on which report, when, and why — for
      dismissals as well as takedowns, since a moderator who looks and finds
      nothing has done something worth being able to show they did. **The
      entry is written in the same transaction as the decision.** An audit log
      that can be missing the entry for the action it exists to describe is
      not one, and the gap would open exactly when a write failed, which is
      when somebody most wants to know what happened.

      `projectId` is **SetNull, not Cascade**, and the project's name is
      copied alongside it. A trail that vanishes with its subject can be
      erased by deleting the subject, which is precisely the move it exists to
      make visible. Same reasoning `ProjectReport.reporterId` already used
      about its author.

      The appeal exists because §2.16 created the need for it. Making the
      takedown stick removed the property §6 decision 11 leaned on when it
      argued the moderation authority was safe *because* its subject could
      undo a mistake — a right trade that left an unreviewed power with no
      route back. One appeal per takedown, compared against the current
      `takenDownAt` rather than "has ever appealed": a project taken down, put
      back, and taken down again is a new case the owner is entitled to
      answer. The limit is the report queue's scarce-resource argument again —
      an owner who can file a hundred can bury everybody else's.

      **Reinstating restores the owner's control, not the project's
      visibility.** It clears `takenDownAt` and stops; the project stays
      private and what to do with it is theirs to decide again. It does not
      bring a site back either, because the files and container were removed.
      Both are said in the notification rather than left to be discovered. A
      reason is *required* to reinstate, unlike on a decision: "we put it
      back" with no account of why is the half of the record that makes the
      other half unfalsifiable, and of every action here it is the one an
      operator has most reason to leave unexplained.

- [x] **Three DB suites were asserting on global queries.** Not defects in
      shipped code, but tests that passed for the wrong reason — and one of
      them was actively corrupting its neighbours.

      `dbScope` stopped these suites truncating each other's rows; it does not
      stop them *reading* each other's. `listReports` and the backfill's total
      are both global by design, so the assertions on them passed or failed
      depending on which other file vitest happened to schedule alongside.
      Adding §2.17's suite changed the scheduling and three failures appeared
      in files nobody had touched.

      The backfill was the interesting one. It sweeps every project in the
      database — correct at boot, and the one thing a test cannot do politely:
      it sealed other suites' rows under a key only its own worker had, so
      their variables became unreadable and *they* failed, in a file with no
      connection to encryption. `backfillSealedEnvVars` now takes an optional
      list of projects to aim at. Boot still passes nothing and sweeps
      everything, and aiming it at one project is a thing an operator wants
      anyway.

      **Verified by running the suite three times rather than once.** Once is
      not evidence about a race; the first green run here was followed by a
      red one.

---

### 2.18 Since (2026-08-31, later)

- [x] **A project's tests have a panel.** The loop this product did not have:
      it could run, deploy and schedule, and the command people type most
      often had nowhere to show its results, so "did I break anything" was a
      terminal tab and scrollback.

      `testCommand` sits beside `startCommand` and means the same thing by
      being null: use the template's. Twelve templates carry a default;
      `static-html` deliberately carries none, and a project on it is told
      there is no test command rather than being handed a guess — running
      `npm test` in a project with no test script fails for a reason its
      author cannot act on.

      **Four outcomes, not two**, for the reason §2.13 keeps six: "the tests
      failed", "they took too long" and "we could not run them at all" send
      the reader to three different places, and a panel that says *failed* for
      the third sends somebody to read their own code for a Docker outage. The
      output is always shown and always scrollable — "failed" with nothing
      under it is exactly what sends people back to the terminal this
      replaces.

      Deliberately **not a second scheduler**: no history, no cron, no sweeper.
      One command, run when somebody asks. The moment it wants to run on a
      schedule it should be a scheduled job, which already exists and already
      reports outcomes properly. And its `withTimeout` passes a rejection on
      rather than folding it into "timeout" — the defect §2.15 had to repair
      in the scheduler's copy, not reintroduced by copying it.

      Three grants, not one: reading the command is a viewer's, running it
      needs what `Run` needs because it executes code in the container, and
      changing it is the owner's — "may edit a file" and "may choose the
      command this project executes" are different, and the second is the
      shape of a backdoor.

---

### 2.19 Since (2026-08-31, later still)

- [x] **A deployment can be rolled back, because its builds are kept.**
      `Deployment.projectId` is unique and the static path renamed a staging
      directory over the live one, so every publish destroyed its own
      predecessor and "put back the one that worked" had nothing to put back.

      **The live release is a pointer, not a copy**, and that is the decision
      the rest follows from. Every build lands in a directory of its own and
      `Deployment.liveReleaseId` names the one being served, so a rollback is
      a database write: nothing is rebuilt, nothing is copied, and what comes
      back is exactly the bytes that were serving before.

      That distinction is the whole feature rather than an optimisation. A
      "rollback" that rebuilt from source would publish whatever the working
      tree says *today*, which is not what anybody means by going back — and
      it would be a different program with the same name. A test writes a
      third, never-published version into the tree before rolling back, and
      asserts the served bytes are still the first build's.

      Falling out of it: the publish no longer deletes the live tree to make
      room, so the window where a site 404s mid-deploy is gone too. And the
      deployment takes the release's own account of itself back on a rollback
      — command, output directory, size, log — because the row describes what
      is *serving*, and leaving the newer build's numbers there would have the
      panel describe a build nobody is being served.

      A **service** deployment is refused, and told why rather than quietly
      doing something else: what it published is a running container built
      from a source tree that has since moved on, so there is no artifact to
      go back to. Five builds are kept, and the live one is never pruned
      however old it is — a rollback to a fortnight-old build must not make
      that build the next thing deleted for being stale.

      A deployment published before this existed has a null pointer and is
      still served from the legacy directory. It must not start 404ing because
      of a column it predates.

- [x] **The gallery could 500 on an account being deleted.**
      `listPublicProjects` read `row.owner.email` where `owner` is a required
      relation — so "cannot happen", except that deleting an account cascades
      its projects and a read landing mid-cascade observes the row without it.
      The `?? "someone"` fallback for a missing name was already there; a null
      owner threw straight past it and took the whole gallery down for
      everybody over one project mid-deletion.

      Found the way the last three were: by a full-suite run failing somewhere
      unrelated to what had just been written. Its test also asserted on the
      global list, which is the third suite this week to do that (§2.17).

---

### 2.20 Since (2026-08-31, evening)

- [x] **The takedown now reaches all seven surfaces.** §2.16 made it stick by
      writing `takenDownAt` and teaching three queries to read it. Four more
      never were: copying the project, redeeming its share link, its scheduled
      jobs, and deploying it again.

      **Copying was the one that made the other three irrelevant.**
      `forkProjectService` and `duplicateProjectService` both build a fresh
      `Project` from the source's template and files — the files being what was
      reported — with the column null on the new row. One button produced a
      project that could be published, deployed, embedded and scheduled exactly
      as the original could not. A guard living on a column is worth no more
      than the operations that cannot produce a row without it, and there were
      two.

      Refused rather than sanitised. Copying `takenDownAt` across would have
      this platform moderate a project nobody reported, and in the fork case
      against somebody moderation never acted on. The refusal names the reason
      and leaves the appeal as the route back, which is what it is for.

      **The share link was the embed's twin and only one of the two was ever
      closed.** Both are bearer strings that were pasted somewhere; a takedown
      called `revokeEmbed` and nothing for the token, and `redeemShareToken`
      joined the holder as a *collaborator* with no clause at all. A project
      taken down for SECRETS went on handing its source to whoever held the
      link; one taken down for MALWARE handed them a container to run it in.
      Now both: the clause is the guarantee and the revocation is cleanup,
      which is §6 decision 13 for the fourth time. The preview endpoint filters
      too — otherwise it becomes the one place that confirms moderation acted,
      to exactly the people holding the link. Existing collaborators are left
      alone; they are not an anonymous surface, and an owner needs them to fix
      whatever the report was about.

      **The scheduled jobs were the worst of the four**, because the harm was
      not who could read the project but what this machine went on *doing* on
      its behalf: an arbitrary command in a container, every night,
      indefinitely, with no screen anywhere in the product that would have
      shown it. Held rather than cancelled — the rows and their schedules
      survive, so a reinstatement restores them, and since `nextRunAt` is not
      advanced while a project is down the existing catch-up rule then does the
      right thing by itself: one run when it comes back, not one per night
      missed.

      **Deploying again was the mildest and is fixed anyway.** `resolveSite`
      refuses to serve whatever `publish()` built, so nothing reached anybody
      — decision 13 earning its keep a third time. It was still a build and a
      container spent on a site that 404s, after which the deploy panel
      reported a live deployment nobody could reach: wrong about the only thing
      it exists to say.

      **Two of the guards were covering for each other, and the mutation pass
      is what found it.** Deleting the sweeper's clause changed nothing
      observable at first, because `runJobNow`'s own refusal then stopped the
      run and the run count stayed at zero. The test now asserts on
      `nextRunAt` instead — the sweep advances it *before* starting anything,
      so an untouched firing is the only evidence the job was never selected.
      A pair of guards that each hide the other's absence is a pair where
      neither is tested, and only a deliberately planted mutant says so.
      Eight planted, eight caught.

- [x] **A fourth DB suite was asserting on a global query.** `runDueJobs` sweeps
      every due job in the database, so `started` is a count of whatever else
      vitest scheduled alongside — and adding the suite above turned
      `schedules.db.test.ts` red in a file nobody had touched, which is exactly
      how §2.17 and §2.19 each found their own instance. Every assertion on the
      sweep's total is now a count of the runs written for *that* job. Verified
      by running the suite three times rather than once; §2.17 learned that the
      hard way too.

---

### 2.21 Since (2026-08-31, evening, later)

- [x] **§2.17's appeal has a client, on both sides of it.** Three endpoints
      with a table behind them, tested, and `grep -rn "moderation\|appeal"
      apps/web/src` returned one hit — a comment saying reporting has no
      appeal. Neither the owner nor the operator could reach any of it.

      The owner gets the trail and the appeal form from their project's menu,
      offered whether or not anything was taken down: dismissals are in the
      trail too, and "reported and a moderator found nothing" is a fact about
      the project its owner is entitled to read. Where a takedown stands, the
      dialog **enumerates what the takedown actually did** — private and
      refused re-publication, no site, no embed, no share link, jobs held,
      no copying and no deploy. Every line is a query in the server, all seven
      of them after §2.20, and until now not one was written anywhere the
      person it happened to could read it.

      The operator gets an Activity tab beside the queue: decisions, appeals
      and reinstatements in one stream, with an unanswered appeal marked and
      the reinstatement offered on it. "Unanswered" is derived from the stream
      rather than asked for separately — it is already ordered and already
      carries both facts — and it is per project, so answering one appeal does
      not silence another. Nothing here grants an operator authority they did
      not have. The one action added is the one that gives authority up.

      **The queue was also telling operators something false.** Its docblock
      and its subtitle both said a takedown was safe because its owner could
      publish the project again, which is precisely what §2.16 removed on
      purpose. §6 decision 11 was amended that day and the screen quoting it
      was not, so for two days the page justified the decision by a property
      the code no longer had. Fixed, and asserted on, because it is the kind
      of wrong that no test would ever have failed for.

- [x] **The dashboard list was handing every collaborator the share token.**
      `listAccessibleProjects` returned whole `Project` rows — to owners and
      collaborators alike — which is the exact hazard the comment on
      `listPublicProjects` twenty lines below it spells out. A read-only
      viewer received `shareToken`, a bearer credential that redeems at the
      link's role, so they could hand out access the owner never offered; and
      the names of every environment variable, which §2.14 already settled
      read-only access does not carry. The columns are now named explicitly,
      where forgetting one is a compile error.

- [x] **`pnpm -r lint` was red on this branch before any of the above**, with
      seven errors nobody had run into. Six were auto-fixable and one was a
      two-line reformat. One of the six auto-fixes then broke `typecheck`:
      `no-unnecessary-type-assertion` looked into a `vi.hoisted` factory,
      decided the cast on it did nothing, and removing it made every index of
      that object an implicit `any`. Restored with a disable comment on the
      line and a note saying which of the two tools is wrong — worth recording
      because "the linter said so" is exactly the reasoning that removed it.

- [x] **A fifth global-query assertion, and this one had a cliff.**
      `listReports` caps at two hundred rows, and `reports.db.test.ts` narrowed
      to its own rows by filtering the result — so past that cap its rows
      never reach the filter and the suite reads "nothing here" rather than
      failing. `listReports` now takes an optional project, which is what the
      per-project surfaces want anyway, and the narrowing is in the query.
      Verified across four consecutive full runs.

---

### 2.22 Since (2026-08-31, night) — §8.1 and §8.2

The first two items of the new §8, which are one change: limits that differ
per account, and a screen that says what yours are.

- **Every account limit now comes from a plan row.** `Plan` is a catalogue
  table — projects, user disk, per-project disk, assistant requests an hour,
  containers at once, and three feature flags — with `users.planId` defaulting
  to a `free` row the migration seeds. `entitlementService.resolveEntitlements`
  resolves it, caches it for 30 s the way `userQuotaService` already cached
  usage, and **fails open to the free plan** rather than to no limit at all: a
  slow lookup must not refuse somebody's save, and an unreachable database must
  not be a way to buy an unbounded quota.

  Wired at every per-account site: `getUserUsage` and both quota assertions,
  the per-project disk ceiling (`diskUsageService` no longer holds a module
  constant), the per-user container cap, and the assistant's hourly budget. The
  machine's own limits — `MAX_CONCURRENT_CONTAINERS`, `CONTAINER_MEMORY_MB`,
  `DEPLOY_MEMORY_MB` — were deliberately left alone, which is now §6 decision
  15.

- **A per-account override, in one `Json` column, parsed rather than trusted.**
  Comping a customer, extending a trial and grandfathering an early account are
  the same operation, and without this each one ends in somebody inventing a
  plan row for one person. It is `.strict()` and bounded, and a row that fails
  to parse falls back to **the plan** — never to something larger. `maxProject`
  for `maxProjects` should not silently apply the plan's number while an
  operator believes they changed it, and garbage in a column should not be a
  quota. `overrideUntil` makes a trial end without anybody remembering to end it.

- **The three feature flags are checked where the thing is created and nowhere
  else.** `provision`, `claimDomain` and `createJob`; not `start`, not
  `runDueJobs`. A plan that lapses does not delete the jobs somebody already
  has or stop them running — an account that drops a tier is blocked at the
  boundary, not seized. The other version of that check is the one that
  destroys work at the moment somebody stops paying, and it is one line away.

- **`GET /account`, and the dialog behind the dashboard's "Plan" button.**
  Usage, limits, the plan, the catalogue, and the per-project breakdown, in one
  response because the three are only meaningful together. This closes the
  §3.2 item: the quota had been enforced since the first release and shown by
  nothing, so the only way to learn where you stood was to be refused — by a
  message that named a limit without saying how close you had been to it or
  which project was eating it.

  The screen says plainly that no plan can be changed from it, because nothing
  on this deployment takes payment and a button that appeared to would be lying
  about what happens next.

**Introducing all of this changed no behaviour, and that was the point.** The
seeded `free` plan holds exactly the `env` defaults it replaced, so the claim
"the limits arrive by a different route and hold the same values" is one the
existing suite checks by passing unchanged. 1536 server tests and 1003 web
tests pass; five suites needed a new mock, and every one of them needed it
because a module they replace wholesale gained an export — none because an
assertion about behaviour stopped holding.

**Not verified: the migration has not been run.** Docker was down on this
machine, so the DB-gated suites were skipped and `plans` has never existed in a
real database. See §5.

### 2.23 Since (2026-08-31, night, later) — §8.3

The third item, and the last of the trio that was meant to land together: a
warning before the wall rather than at it.

- **`QUOTA_WARNING`, sent on the crossing and not on the state.** An account
  that reaches the last fifth of either quota is told once. One bit on `users`
  — `quotaWarnedAt` — is what makes it a notification about a change: set on
  the way in, cleared on the way back under, and nothing said in between. An
  account that sits at 90% for a month is one message, because a message a week
  about a number that has not moved is how a warning people needed teaches them
  to filter it (§6 decision 14).

- **Dropping back under the line is silent**, which is where this departs from
  a job recovering — and the departure is the argued part. A job that starts
  working again reverses a failure somebody was told about and may have been
  acting on. Nobody was ever harmed by a wall they did not hit, and somebody
  who has just deleted a project to make room does not need to be told that it
  worked. The bit is cleared and that is all, so the next crossing speaks.

- **One bit for both quotas, not one each.** Disk and project count are two
  different rooms to run out of, but the state being announced is "this account
  is running out of room": the message links to the screen that shows both
  meters, and a second mail the same week adding "also, projects" is precisely
  what decision 14 exists to stop. The alternative is recorded here rather than
  left implied, because it is the reading somebody will arrive at later.

- **Reviewed where a fresh measurement already exists** — inside
  `getUserUsage`, which is the one place that walks the trees — and not
  awaited. A save must not wait on an announcement about it, and nothing in
  `reviewQuotaWarning` throws at its caller.

- The notification links to `/?view=account`, and the dashboard now opens the
  plan dialog on that query. A message that pointed at the dashboard and left
  the reader to find the button would be telling somebody where to look rather
  than showing them.

**Mutation-tested, both guards.** Removing the transition check (`near ===
warned`) so that every measurement announces itself: 2 tests failed. Removing
the silence on recovery so that clearing the bit also sends a message: 2 tests
failed. Neither guard is decoration.

1547 server tests and 1003 web tests pass. **The migration for this has not
been applied either** — same reason, same caveat, see §5.

### 2.24 Since (2026-08-31, night, later still) — §8.6

API keys, and a public API that is a *designed surface* rather than the
signed-in one with a different token in front of it.

- **`ApiKey` is not `UserToken` with a third purpose.** That table is
  single-use, arrives by email and lives an hour. This object is presented on
  every request, for months, from a CI runner nobody is looking at — the
  opposite on every axis — so the questions it has to answer are different
  ones: what it may do, how it is revoked, and whether anybody can tell it is
  still in use. Hence `lastUsedAt`, which is the field that makes revoking an
  unfamiliar key a safe act rather than a gamble, and a `revokedAt` timestamp
  instead of a delete, because "that key was revoked on Tuesday" is the
  sentence somebody needs after an incident and a deleted row answers nothing.

- **The secret is shown once and stored as a hash**, with the public `prefix`
  kept in the clear — it is in the presented string, it is what the lookup
  keys on, and it is what lets a key be named in a list without the row holding
  anything usable.

- **The containment is a router, not a checklist**, and this is the load-bearing
  decision. A key authenticates against `routes/v1/pub.ts` and nowhere else in
  the product. Had it produced the same auth context a session does, it would
  have inherited the entire signed-in surface — every project deletable, every
  environment variable readable, the plan changeable — and the only thing
  between a leaked CI secret and all of that would be a list of exceptions
  somebody keeps complete by hand. **A route that is not written in that file
  is not reachable by a key**, which is §6 decision 13's shape again: the
  guarantee lives where it cannot be skipped. Now §6 decision 17.

  Two exclusions follow and are tested as 404s rather than as refusals, because
  the claim is that they were never written: **a key cannot manage keys**
  (minting and revoking are on the session-only account router, so a stolen key
  cannot issue itself a wider one — revocation a thief can undo is not
  revocation), and **a key cannot delete anything** (no CI story needs it, and
  §3.3 records that this platform has no backups).

- **Four endpoints, three scopes.** `projects:read`, `projects:write`,
  `deploy`. Publishing names its access level as `owner` rather than taking a
  default — the thing §3.1 records one endpoint as failing to do — and both
  write routes carry limiters, because a machine with a key in a loop is
  exactly what discovers an unbudgeted route.

- **Every refusal on a presented key says the same thing.** Distinguishing "no
  such key" from "revoked" from "expired" tells somebody holding a stolen
  string which of those it is, and tells the rightful owner nothing their own
  list does not already say.

**A real bug, caught by its own test:** the secret was first encoded
`base64url`, whose alphabet contains `_` — the character the three parts of a
key are split on. Roughly one key in three would have failed to verify
immediately after being issued. Fixed by encoding hex, which removes the
ambiguity rather than teaching the parser to cope with it.

1568 server tests and 1012 web tests pass. **This migration has not been
applied either** — see §5.

**Noise found while running this, not caused by it:**
`utils/publishBudget.test.ts` emits several unhandled
`TypeError: Cannot read properties of undefined (reading 'catch')` from
`asyncHandler`, on its own, on an untouched file. Every test in it passes and
the run exits 0, so it is noise rather than a failure — recorded here so the
next person to see it does not go looking for it in §8's work. **Not
investigated.**

### 2.25 Since (2026-08-31, night, last) — §8.7

The operator's console: find an account, read it, change what it is allowed —
and, separately, find out whether the machine is full.

**This is the first authority in the product that acts on a person rather than
on a project**, and §6 decision 11 says plainly that the moderation power is
small *because* nothing reviews it and must not grow until something does. So
the review shipped in the same commit as the power, not after it:

- **The change and its record commit together.** `account_actions` is written
  on the same transaction client as the update, so the log cannot be missing
  the entry for the thing it exists to describe — and the gap would appear
  exactly when the write failed, which is when somebody most wants to know.
  Mutation-tested: moving the insert outside the transaction fails 3 tests.
- **The reason is required**, by the schema, by the service, and by the button
  being dead until something is typed. An operator who can silently change what
  somebody pays for is a worse position than this product was in before the
  console existed.
- **The account holder is told**, with a new `PLAN_CHANGED` notification
  carrying what changed and the reason verbatim. Same argument the takedown
  notification makes: a decision taken about somebody, by somebody else, is one
  they hear from us rather than discover from a refusal — or from a number that
  changed overnight.

**A second audit table, not a third kind of moderation action.** Every row in
`moderation_actions` names a project, and `projectName` is copied into it so
the record still reads after the project is deleted. An action against an
account has no project, so fitting one in meant making that column nullable:
loosening a constraint that is doing real work, to hold an event that is not
part of the same conversation. §2.17 put the appeal in that table because
"taken down, appealed, reinstated" only reads in order; "moved to Pro" is not
in that sequence and would appear in a project's trail as noise. Same
discipline in the new table, plus one difference: `reason` is `NOT NULL` here,
where a moderation decision's is optional.

**Suspension was considered and refused** — recorded rather than left as an
absence somebody fills in later. Locking a person out of their own work is a
far larger power than making one project private, and decision 11's argument is
that the authority stays the smallest one that resolves a complaint. Now §6
decision 18.

**And the machine, which closes §3.2's `/metrics` item.** `GET /admin/machine`
and a panel: containers running against the cap, uptime and resident memory,
every counter this codebase has been carefully incrementing all along, and one
number that is not a gauge but a defect report — scheduled runs sitting in
`RUNNING`. That count should return to zero, and §3.1 records why it may not.
The panel says so in words, because the wedge is otherwise completely silent:
the job reports `SKIPPED` from then on and §6 decision 14 correctly keeps quiet
about it.

Two smaller things worth naming because each had a plausible wrong answer:
an **archived plan can be moved away from and not onto** — the archive is what
stops a withdrawn tier reaching somebody new, and an operator doing it by hand
is exactly the case it exists to stop — and an **override is validated by the
same schema that reads it back**, so one that could not be parsed can never be
stored. The alternative fails silently at resolution time, with the operator
believing it applied.

1588 server tests and 1030 web tests pass. **This migration has not been
applied either** — see §5.

### 2.26 Since (2026-08-31, night, after §8) — the restart wedge

The worst thing on §3.1, reached by the most ordinary operation there is:
deploying. `runJobNow` writes a `RUNNING` row before it starts a job; nothing
ever cleared one the process did not come back to; the overlap check was
`findFirst({ jobId, status: "RUNNING" })` with no age bound. So from the next
firing onwards the sweep claimed the job, found the immortal row, wrote
`SKIPPED` — and `SKIPPED` is deliberately not a verdict (§6 decision 14), so
nobody was ever told. A nightly backup died on the evening somebody deployed
and reported nothing, forever.

**Three things were needed and the third was the one that mattered.**

**A name for it, settled before the reconciler that depends on it.** §3.2 was
right to list this separately as a design question. The obvious answer was
`ERRORED`, which §3.1 argued for on the grounds that it already means "the
machine could not run it" — and that turns out to be exactly what it does not
mean here. `ERRORED` says the command never started. An abandoned run *did*
start, and may well have finished all of its work a second before the restart
landed on it. Telling somebody "we could not run it" about a backup that in
fact ran is the same class of lie `TIMED_OUT` exists to avoid, and it changes
what they should do next: re-run an `ERRORED` job, look at what the command
actually did before re-running an `ABANDONED` one. So the seventh status, with
the precedent already in the file — `TIMED_OUT` is kept apart from `FAILED` for
this reason and no other. Not a verdict, so a job that runs normally next time
says nothing at all.

**The boot reconcile now knows about rows.** `reconcileOnBoot` has always swept
containers and directories and never looked at a table, which is the root cause
of both defects here. `reconcileJobRuns` names every `RUNNING` row at boot —
unconditionally, because nothing can be running in a process that has just
started — and `reconcileDeployments` settles every `BUILDING` row the same way.
The deploy half is the softer landing §3.1 described: nothing is wedged, since
`reserve()` overwrites the status on the next publish, but until somebody
deploys again the panel reports a build in progress that no process is running,
which is the only thing that panel exists to say.

**And the query is bounded, not just the cleanup.** §6 decision 13 for the
fourth time: the reconcile is cleanup that touches rows and can be missed, and
the clause is the guarantee. A `RUNNING` row older than twice the run timeout
cannot hold a job hostage, and it is *named* rather than merely stepped over,
so the history reads as what happened instead of showing a run eternally in
progress.

Two mutants, both caught: dropping the age bound fails "does not believe a
RUNNING row of any age", and writing `ERRORED` where `ABANDONED` belongs fails
two. **What is not covered is the wiring in `index.ts`** — a boot sequence has
no test on this codebase, so the guarantee that these two are actually called
rests on reading, as it does for the eight other things called there.

1598 server tests and 1030 web tests pass. **This migration has not been
applied either**, and it is another `ALTER TYPE ... ADD VALUE` — see §5.

### 2.27 Since (2026-08-31, night, after §8) — the three small ones

Two of §3.1's remaining three and one habit, in one commit because they are one
file and one argument.

**`POST /:projectId/test` and `GET /:projectId/export` now carry budgets.**
§2.13 gave "run now" a limiter on the stated grounds that it is the only route
that starts a container on demand; §2.18 then shipped a second one, argued its
three access levels carefully, and gave it no budget. Same limit as the job
run, deliberately: one person's manual runs are the same cost to this machine
whichever button started them. Export is the quieter half — no container, but a
walk and a zip of an entire working tree per request, at viewer level, on a
project allowed to be gigabytes — so it gets a looser one rather than none.

**No test, and that is the local convention rather than an omission.** Nothing
in this codebase tests an `express-rate-limit` middleware; the three files that
assert on `RATE_LIMITED` are all testing service-level budgets. Exercising one
of these would mean thirty-one authenticated requests to prove a constant.

**The defaulted access level is now named.** `assertProjectAccess`'s third
parameter defaults to `"editor"` and `setProjectEnvController` was the only
caller in the codebase omitting it. Editor is the right answer — an editor can
already run arbitrary code in the container that reads these variables — and
the point is that it is now the answer somebody chose. §2.13 and §2.18 both
exist because naming the level changed it.

**And the comment that sat above the wrong routes** has the moderation pair
under it again. Recorded rather than fixed silently when it was found, because
`routes/v1/projects.ts` is where somebody goes to learn what is guarded by
what, and a paragraph pointing at the wrong block is worse there than nowhere.

1598 server tests pass, unchanged: nothing here has a behavioural test, which
is exactly what makes them small.

### 2.28 Since (2026-08-31, night, last) — pagination

The last unblocked item, and the one §4 put last on the grounds that nothing
is currently over any of the caps — which is exactly why it should be done
before something is.

**The defect was never "lists are long".** It is that an array is the one
shape that cannot say *there is more*. Three lists were silently truncated at
a constant — 200 reports, 100 moderation actions, 50 public projects — and the
fourth had no bound at all, so both failure modes were present at once: a list
that lies about being complete, and a query with nothing stopping it.

**One page shape, `{ items, nextCursor }`, for all four.** Cursor and not
offset, because every one of these is `createdAt desc` on a table that takes
new rows at the top: an offset shifts under insertion, so page two both repeats
and skips. Three details each had a plausible wrong version that no screen
would have shown for months, and each is now a test:

- **`take: limit + 1`.** Reading one row more is what makes "is there another
  page" a fact rather than a guess. A count query is a second scan; calling a
  full page the last one gives a "show more" that loads nothing.
- **The order breaks ties on `id`.** `createdAt` alone is not stable — one
  project reported by two people at once shares a millisecond — and a cursor
  into an unstable order drops rows silently. `listAccessibleProjects` had no
  `orderBy` at all, which a cursor cannot be built on.
- **The extra row is peeked at, never returned.** Otherwise one row appears on
  two pages.

**Who follows a cursor and who is handed one is the decision worth naming.**
Three screens get a "Show more" that appears only when there is another page.
The dashboard does not: it searches and sorts the whole set in the browser, so
a page break there would mean typing a project's name and being told it does
not exist because it is on page two — the §2.21 mistake, rebuilt deliberately.
So `listProjectsApi` follows its own pages to the end. **Paging bounds the
query; it must not silently bound the answer.** That loop is itself bounded at
twenty pages, because a client loop with no stop is a client loop that hangs on
a server bug, and stopping is visibly wrong where spinning is invisibly wrong.

**`listModerationActions` is deliberately not paged.** One project's trail is
bounded by what has been done to one project, it is read as a sequence rather
than a feed, and a page break in the middle of "taken down, appealed,
reinstated" would hide the ending. The rule is not "paginate everything"; it is
that a list which can grow without bound must be able to say so.

**Two response shapes changed** — `GET /api/v1/projects` and
`GET /api/v1/admin/reports` no longer answer with an array, and `/admin/reports`
lost its `reports` key for `items`. The public API's `GET /pub/projects` changed
with them and is the one place the cursor is exposed rather than followed: a
script is the one consumer that can be trusted to loop, and one response
holding every project an account owns is the request most likely to end up in a
cron job.

One mutant, caught: dropping the `id` tiebreak from an order fails the test
that asks for it by shape.

1628 server tests and 1042 web tests pass.

### 2.29 Since (2026-09-01) — §9.1, a delete that can be undone

The first of the four halves §9 split out, and the one with a user on the
other end of it who was one dialog away from losing their work.

**What replaced what.** `DELETE /:projectId` is the same route, the same verb
and the same button, and it no longer deletes anything. A recoverable path
that sits *beside* the irreversible one protects nobody — the person about to
make the mistake is the person who will not go looking for the safer option —
so it had to take its place. The old body is now `purgeProject`, reached only
from the trash: by the sweeper after seven days, or by an owner who does not
want to wait.

**The split is the design, and it is wrong in two directions.** A trashed
project stops its container, stops its database, unpublishes its site, revokes
its embed and clears its share token — immediately. Anything that goes on
serving the public or costing money for a week is indefensible. What is *held*
is the working tree, the row, and the managed database's **volume**, because
the volume is the user's data and a trash that gives back an empty project is
not a trash. Both halves are mutation-tested: destroying the volume on the way
in fails two tests, and leaving the share token alive fails one.

**One line covers the authenticated product.** `getProjectAccess` is what every
route and every socket handler reaches a project through, so `if
(project.deletedAt) return null` closes the editor, the terminal, the deploy
panel, the jobs and the rest at once — as a 404, which is also the honest
answer. Restoring is the single operation that must see past it, so it reads
the row itself and says so rather than adding a flag to the function ninety
callers trust.

**And the surfaces that never see a session were enumerated rather than
recalled**, because §2.20 is the record of what happens otherwise: the gallery,
the dashboard list, the site, the embed, the share-link redeem and preview, and
the job sweep. WHERE clauses, not cleanup — §6 decision 13 for the fifth time.
The share token is *both* cleared and filtered, which §2.20 settled is not
belt-and-braces but the rule.

**Two quota decisions, each with a plausible wrong answer.** A trashed project
stops counting immediately — a trash that holds somebody at their project limit
for a week is one they empty in the first minute, which is the same as not
having one. And because it stops counting, **restore has to ask for room**:
`assertCanCreateProject` runs first, so an account that filled up in the
meantime is told which limit it hit instead of being restored into a state
where nothing can be created.

**The one test that mattered was the one I had not written.** Removing the
`getProjectAccess` guard — the single most load-bearing line in the change —
left all 1650 tests passing. That is the §3.1 lesson arriving on schedule: the
suite was green about a feature whose central guard did nothing.
`trashGuards.test.ts` exists because of it, and the mutant now fails two.

**Deliberately not done:** restoring does not republish the site, re-issue the
embed or bring the share link back. Those were public surfaces the owner gave
up when they deleted the project, and handing them back unasked would be this
platform deciding who may read something on somebody's behalf.

**This does not close §3.3's backup row and must not be read as doing so.** A
backup answers "the host died" and needs a destination; this answers "I meant
the other project".

1656 server tests and 1051 web tests pass. **This migration has not been
applied either** — see §5. It is the first of these to add an index rather than
a column alone.

---

## 3. Open

### 3.1 Defects — code that is merged and wrong

The three deployment defects were fixed on 2026-08-29 (§2.8), and the last
entry here — public projects with no report mechanism and no review — was
closed on 2026-08-30 (§2.11).

**This section has now read "Empty" three times while merged code was wrong**,
and it is worth being precise about why, because the pattern is not bad luck.
Five defects have been found since it was emptied, and not one of them arrived
by being written down first:

- a viewer could duplicate a project and take its environment variables (§2.14)
- `withTimeout` reported a crashed exec as a timeout (§2.15)
- `updateJob` never checked which project a job belonged to (§2.15)
- and the two below.

Every one was found by reading two shipped things against each other. A list
of *known* defects cannot prompt that, so an empty §3.1 means "nobody has
looked lately" and never "the code is right". Read it that way.

- [x] **A moderator's takedown did not take anything down.** Fixed
      2026-08-30 — see §2.16. `reviewReport`'s ACTIONED branch set
      `visibility: PRIVATE` and stopped, and this codebase says plainly what
      that does: `setProjectVisibility` is documented as "a decision about who
      may read the source", and deliberately leaves the share token, the
      collaborators and the deployment alone.

      That reasoning is right for an owner toggling their own project, and it
      does not survive being reused as a remedy. A project reported for
      MALWARE went on being **served** at its public deploy URL; one reported
      for SECRETS went on serving its source through its embed token. Both are
      anonymous surfaces, and the embed link is exactly the thing that would
      have been pasted around. What the moderator actually achieved was
      removing it from the gallery.

      `unpublish()` and `revokeEmbed()` both already existed. Moderation
      called neither.

- [x] **And the owner could undo it instantly.** Fixed 2026-08-30 — see
      §2.16. `setProjectVisibility` requires owner access and checks nothing
      else, so the person a takedown was applied to could set the project
      public again in one request. Together with the item above, ACTIONED was
      a decision with no mechanism behind it at all.

- [x] **The takedown reaches three surfaces and there are four it does not.**
      Fixed 2026-08-31 — see §2.20.
      §2.16 made a takedown stick by writing `takenDownAt` and teaching three
      queries to filter on it: the gallery's `visibility`, `resolveSite`, and
      the embed's `resolveToken`. Reading those three against the rest of the
      surface finds four more that were never told.

      1. **Copying launders it.** `forkProjectService` and
         `duplicateProjectService` both build a fresh `Project` row from the
         source's template and files, and neither carries `takenDownAt`. The
         files are the thing that was reported. One button produces an
         identical project with the column null, which defeats all three
         existing guards at once — the copy can be published, deployed,
         embedded and scheduled. A guard that lives on a column is only as
         good as the operations that cannot produce a copy without it, and
         there are two.

      2. **The share link still redeems.** `redeemShareToken` looks the token
         up and joins the caller as a collaborator with no takedown clause,
         and the takedown revokes the embed but not the token. Those two are
         the same kind of object — a bearer string that was pasted somewhere —
         and only one of them was closed. A project taken down for SECRETS
         goes on handing its source to anybody holding the link; one taken
         down for MALWARE hands them a container to run it in.

      3. **Scheduled jobs keep running.** `runDueJobs` selects on `enabled`
         and `nextRunAt` and nothing else, so a taken-down project executes
         its command in a container every night, indefinitely. This is the
         one surface where the harm is not who may read the project but what
         this machine goes on *doing* on its behalf, which makes it the worst
         of the four and the least visible: nothing in the product would ever
         show it.

      4. **The owner can rebuild the deployment.** `publish()` checks the
         template, the feature flag and an in-flight build, but not the
         takedown. The site is still not *served* — `resolveSite` filters, and
         that is §6 decision 13 earning its keep for the third time — so this
         is the mildest of the four. It is still a container and a build
         spent on a project that will 404, and a deploy panel afterwards
         reporting a live deployment nobody can reach, which makes the panel
         wrong about the only thing it exists to say.

      The fixes belong where decision 13 puts them: in the queries and at the
      operations, not in the takedown's cleanup. Three choices worth naming
      before writing them, because each has a plausible wrong answer:

      - **A copy is refused, not sanitised.** Carrying `takenDownAt` onto the
        copy would have this platform moderate a project nobody reported,
        against an owner who in the fork case is not the one moderation acted
        on. Refusing says what happened and leaves the appeal as the route
        back.
      - **The token is revoked *and* the redeem query filters.** Both, for the
        reason decision 13 gives: revocation is cleanup that touches a row and
        can be missed, the clause is the guarantee. Existing collaborators are
        left alone — they are not an anonymous surface, and an owner needs
        them to fix whatever the report was about.
      - **Held, not deleted.** A taken-down project's jobs stay in the table
        with their schedules intact, so reinstatement restores them. The
        sweeper's existing catch-up rule then does the right thing by itself:
        one run when the project comes back, not one per night missed.

---

**Added 2026-08-31 (night), from a sweep of the whole tree** rather than from
any list. What the sweep confirmed is worth saying before what it found: the
guards this codebase is careful about are in place and hold up to reading.
Every mutating socket event is behind `requiresEdit`, including the two
collaborative-document handlers where a viewer writing through the CRDT path
would have been invisible; every project route names its access level; the
takedown now reaches all seven surfaces (§2.20); path confinement, the egress
gateway, the third origin and the container limits are all where they claim to
be; and `grep` for `TODO|FIXME|HACK` over ~51k lines of source still returns
nothing. Of the ninety-odd endpoints, exactly one has no client, and it is
`/metrics`, which is not supposed to have one.

The five below are what a sweep at that altitude does turn up. Four of the
five are one shape: **state that outlives the process, and a boot that
reconciles containers but not rows.**

- [x] **A restart during a scheduled run kills that job permanently, and says
      nothing.** Fixed 2026-08-31 — see §2.26. All three parts: the boot
      reconcile now names orphaned `RUNNING` rows, the overlap check is bounded
      by age, and the sixth case got a name of its own rather than being filed
      under `ERRORED`.
      The worst thing on this page, and it is reached by the most
      ordinary operation there is.

      `runJobNow` writes a `RUNNING` row before it starts, which is right —
      §2.13 chose that deliberately so a stuck run is visible. Nothing ever
      clears one that the process did not live to finish. `reconcileOnBoot`
      exists and sweeps *containers and directories*; it has never looked at a
      row. The overlap check is `findFirst({ jobId, status: "RUNNING" })` with
      no age bound, so from the next firing onwards:

      1. the sweep claims the job and calls `runJobNow`,
      2. which finds the immortal `RUNNING` row and writes `SKIPPED`,
      3. and `SKIPPED` is deliberately not a verdict (§6 decision 14), so
         `lastVerdict` ignores it and **nobody is ever told**.

      A nightly backup dies on the evening somebody deployed, and reports
      `SKIPPED` every night thereafter forever. That is precisely the failure
      §2.15 built the notification system to make visible, arriving through
      the one status that system is designed to stay quiet about — two correct
      decisions composing into a silence neither of them intended.

      Three things are needed and the third is the one that matters: reconcile
      orphaned `RUNNING` rows at boot; bound the overlap check by age so a row
      from a process that is gone cannot hold a job hostage forever; and settle
      what a run abandoned by a restart *is*. It is not `SKIPPED` — nothing
      overlapped — and it is not `FAILED`, because the command never gave a
      verdict. `ERRORED` already means "the machine could not run it", which is
      exactly what happened, and it is already a non-verdict, so a job that
      recovers on the next firing correctly says nothing.

- [x] **A deploy interrupted the same way leaves the row `BUILDING` forever.**
      Fixed 2026-08-31 — see §2.26, in the same commit and for the reason §4
      gave: one boot pass, two kinds of row.
      The same root cause with a milder ending. `Deployment.status` goes to
      `BUILDING` before the build and nothing at boot puts it right, so the
      panel reports a build in progress that no process is running. It
      self-heals on the next publish, because `building` is in-memory and
      `reserve()` overwrites the status — so unlike the job above nothing is
      wedged, but until somebody deploys again the panel is simply wrong. Fix
      it in the same pass and for the same reason: the boot reconcile should
      know about rows.

- [x] **`POST /:projectId/test` starts a container and has no budget.** Fixed
      2026-08-31 — see §2.27, with the export beside it. Every
      other route that costs real compute carries one — `createLimiter`,
      `installLimiter`, `deployLimiter`, `queryLimiter`, and `jobRunLimiter`,
      which §2.13 added to "run now" on the stated grounds that it is the only
      one of those routes that starts a container. §2.18 then shipped a second
      route that starts a container, gave it three carefully argued access
      levels, and no limiter. The argument for `jobRunLimiter` applies to it
      word for word.

      `GET /:projectId/export` is the same question one notch quieter: it walks
      and zips an entire working tree per request, with no budget, at viewer
      level.

- [x] **One project write takes its access level from a default argument.**
      Fixed 2026-08-31 — see §2.27.
      `assertProjectAccess`'s third parameter defaults to `"editor"`, and
      `setProjectEnvController` is the only caller in the codebase that omits
      it. Editor is very likely the right answer — an editor can already run
      arbitrary code, so setting a variable grants them nothing new — but it is
      the answer this endpoint gets by falling through rather than by anybody
      choosing it. Every other write on the page names its level, and several
      (§2.13, §2.18) exist specifically because naming it changed the answer.
      A default that is load-bearing in exactly one place is a default that
      will eventually be changed by somebody reasoning about the other ninety.

- [x] **A comment in `routes/v1/projects.ts` sits above the wrong routes.**
      Fixed 2026-08-31 — see §2.27. The
      paragraph introducing the moderation pair ("the other side of
      moderation... both are the owner's") is immediately followed by the
      *tests* block and its own comment, with the moderation routes below that.
      Trivial to fix and recorded rather than fixed silently, because this file
      is where somebody goes to find out what is guarded by what.

### 3.2 Unblocked — work, not decisions

Emptied on 2026-08-29, when everything then in it moved to §2.8. Four items
arrived on 2026-08-30, none of them from a feature list: they are what reading
the shipped features against each other turned up. Nothing here is blocked.
Listed in the order §4 recommends.

- [x] **Nobody is ever told anything.** Shipped 2026-08-30 — see §2.15.

- [x] **Moderation has no audit log.** Shipped 2026-08-30 — see §2.17.

- [x] **A taken-down project has no appeal.** Shipped 2026-08-30 — see
      §2.17, in the same work as the trail, because they are one conversation.

- [x] **The test command has no panel.** Shipped 2026-08-31 — see §2.18.

- [x] **A deployment cannot be rolled back.** Shipped 2026-08-31 — §2.19.


- [x] **§2.17 shipped an appeal nobody can file.** Shipped 2026-08-31 —
      see §2.21. The moderation trail, the
      appeal and the reinstatement are all real: three endpoints, tested, with
      a table behind them. `grep -rn "moderation\|appeal\|takenDown" apps/web/src`
      returns one hit, and it is a comment in `ReportProject.tsx` saying that
      reporting has no appeal. Nothing on either side of the transaction can
      reach any of it.

      For the **owner**, that means the notification telling them their
      project was taken down is the entire feature. `GET /:projectId/moderation`
      would show them what was decided and when; `POST /:projectId/appeal`
      would let them answer it. Neither has a caller. The appeal was built
      because §2.16 removed the property §6 decision 11 leaned on — that the
      subject of a wrong decision could undo it — and an appeal that cannot be
      filed restores exactly none of that.

      For the **operator**, `ReportQueue.tsx` lists reports and reviews them
      and stops there. `GET /admin/moderation` and
      `POST /admin/projects/:id/reinstate` have no caller either, so an appeal
      that could be filed could not then be read, and a takedown that was
      wrong could not be lifted. The queue shows the case that arrives and
      nothing that happens afterwards.

      This is not a missing feature so much as a missing half of a shipped
      one, and it is the sharpest instance yet of the thing §3.1 keeps saying:
      the server suite is green, every endpoint has a test, and the feature
      does not exist for any person who would use it. **A test that calls the
      controller directly cannot notice that nothing else does.**

      Deliberately not in scope: giving operators any authority they do not
      already have. §6 decision 11 says the power stays small *because* it is
      unreviewed, and must not grow until something reviews it. This is that
      something finally becoming usable — not an argument for more of it.


---

**Added 2026-08-31 (night), from the same sweep.** None of these is a missing
feature in the sense of a feature nobody built. Each is a capability the server
already has and nobody can reach — the shape §2.21 just finished paying for
once, found three more times.

- [x] **Quotas are enforced and never shown.** Shipped 2026-08-31 — see
      §2.22, together with §8.1, because a usage screen with no plan behind it
      would have had to invent one. `getUserUsage` computes a
      person's project count and disk against their limits;
      `assertCanCreateProject` and `assertUserDiskQuota` refuse on it;
      `diskUsageService` tracks the same per project. There is no endpoint and
      no screen. The only way to learn where you stand is to be refused, and
      the refusal names a limit without saying how close you were to it or
      which project is eating it.

      That is the worst possible moment to find out, and the fix is small: an
      endpoint and a line on the dashboard. The per-project breakdown is the
      half that makes it actionable — "you are out of space" is not a thing
      anybody can act on, and "this project is 4 GB of the 5 you have" is.

- [x] **The operator can see the report queue and nothing about the machine.**
      Shipped 2026-08-31 — see §2.25, alongside §8.7, because an operator
      looking up an account and an operator asking whether the machine is full
      are the same person at the same screen.
      `/metrics` is the one endpoint in the product with no client, and unlike
      the appeal that is a defensible choice — a scrape target is not a screen.
      But it means the counters this codebase has been carefully incrementing
      all along (`jobs_started`, `jobs_skipped`, `report_actioned`,
      `notifications_created`, and the rest) are visible only to somebody who
      curls the port.

      What is actually missing is smaller than a monitoring stack and more
      useful: how many containers are running against `MAX_CONCURRENT_CONTAINERS`,
      how much disk the deployments and releases hold, and — given the defect
      above — how many scheduled runs are sitting in `RUNNING`. An operator
      today cannot answer "is this machine full" from any screen, which is the
      question a three-container cap makes them ask most often.

- [x] **Nothing that returns a list is paginated, and they fail in two
      different directions.** Fixed 2026-08-31 — see §2.28. `listReports` takes 200, `listRecentModeration`
      takes 100, `listPublicProjects` takes 50 — each silently, with no
      indication that there was more and no way to ask for it. Meanwhile
      `listAccessibleProjects` has no cap at all, so a user with five hundred
      projects gets five hundred rows in one payload.

      The §2.21 fix has already shown what the first kind costs: a test
      narrowing after a capped query would have read "nothing here" rather than
      failing, and only luck put that cap in view. A truncated list that says
      it is complete is worse than a short one that says it is not.

- [x] **A run abandoned by a restart has no name.** Settled 2026-08-31 —
      `ABANDONED`, see §2.26. Listed separately from the
      defect above because it is a design question rather than a fix: `RUNNING`,
      `SKIPPED`, `FAILED`, `TIMED_OUT` and `ERRORED` were chosen (§2.13) to
      keep "your command is wrong" apart from "we could not run it", and the
      sixth case — "we started it and then stopped existing" — was not among
      them because nothing had thought about restarts. Settle it once, in the
      same place §2.13's table lives, before writing the reconciler that
      depends on the answer.


### 3.3 Blocked on a decision or on infrastructure

Each is named with what blocks it, so none reads as ready to start.

- [ ] **Certificates for custom domains.** **Split by §9.2** — the code half
      is one endpoint telling a TLS terminator which hostnames are real, and
      what is left here is whether this deployment terminates TLS and where
      that key lives. What is left of the row that used
      to say "custom domains", once the code half shipped on 2026-08-30
      (§2.12). A verified domain is served over plain HTTP today. Over HTTPS
      each one needs a certificate for its own name — not the wildcard that
      covers the generated subdomains — which means ACME, an account key, a
      challenge the deploy listener can answer, and renewal. That is a
      deployment decision about what this platform is allowed to talk to and
      where its keys live, and it is genuinely infrastructure in a way the
      rest of that row was not.
- [ ] **Process snapshots.** `warmStart.ts` skips the redundant install, so what
      remains is the dev server process, which still dies with its container.
      Resuming a running process is a mechanism nothing here resembles, and it
      needs a decision about how much disk a suspended project may hold. The
      last thing CodeSandbox does that this does not.
- [ ] **Autoscale.** Still blocked, and §9.5 says why it gets closer without
      being worked on: §9.3's compute meter is the input its cost model is
      missing. What is left of the row that used to say "autoscale and
      scheduled jobs", once the scheduling half shipped on 2026-08-30 (§2.13).
      Still a different product with a different cost model: always-on compute
      exists in its smallest useful form, and deciding how many copies of it to
      buy in response to load is a pricing decision before it is an
      engineering one.
- [ ] **Debugging.** Deferred on purpose — see §6, decision 1 — and listed
      here so its absence is visible rather than forgotten. If
      debugging becomes the deciding feature, the answer is Route A
      (openvscode-server), **not** a hand-built debug adapter client — and Route
      A puts the multiplayer layer, the assistant, the run control and the
      preview behind a rewrite. Revisit the route, not the row.

- [ ] **Backup and restore.** **Split by §9.1**, which takes the recoverable
      delete and deliberately leaves this row open: a trash answers "I meant
      the other project" and a backup answers "the host died", and only the
      second needs a destination. Do not read §9.1 as closing this.
      Added 2026-08-31 after a sweep found no story
      for either. Everything a user has lives in exactly one place: the working
      tree on the host's disk, the rows in one Postgres, the published releases
      in a sibling directory. `deleteProjectService` is thorough and
      irreversible, the delete confirmation is a dialog, and there is nothing
      behind it — no soft delete, no snapshot, no dump.

      Placed here rather than in §3.2 because the code is the small half. Where
      backups go is a deployment decision with a cost attached — object storage
      off this VM, or a second disk, or nothing and a documented acceptance
      that this platform loses data when its host does. That is the same class
      of decision as the ACME row above it, and it should be made rather than
      arrived at.

      Worth noting what already exists and does not solve it: per-project
      checkpoints (§2.x) are on the same disk as the thing they snapshot, and
      `GET /:projectId/export` is a manual, per-project, user-initiated zip. A
      backup is the one that runs when nobody remembers to.

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
4. ~~**§3.1 report and review.**~~ Done 2026-08-30. It did need the decision
   first, exactly as this line said — and that decision took an afternoon,
   having sat on the list as though it were infrastructure.
5. ~~**§3.4 the remaining debts**.~~ Done 2026-08-29.
6. ~~**§3.2 env vars and the dashboard list view**.~~ Done 2026-08-29.

7. ~~**§3.4 the dangling section references.**~~ Done 2026-08-29, and it was
   worth doing while §6 was fresh — though §6 turned out to be the right home
   for only six of them.

8. ~~**§3.3 follow-mode with viewport sync.**~~ Done 2026-08-29. It should not
   have been in §3.3 at all: its stated blocker was a feature the editor
   already had.

9. ~~**§3.3 custom domains — the code half.**~~ Done 2026-08-30 (§2.12), by
   splitting a row whose blocked half is still in §3.3.
10. ~~**§3.3 scheduled jobs.**~~ Done 2026-08-30 (§2.13), the same way, out of
    the row that also held autoscaling.
11. ~~**Env vars encrypted at rest, and the escalation found beside it.**~~
    Done 2026-08-30 (§2.14). From neither §3 nor any feature list — see §1.

12. ~~**§3.2 notifications.**~~ Done 2026-08-30 (§2.15). Chosen first for
    leverage — it closes the same silence in two shipped features — and it
    returned more than that: building the thing that watches a feature is what
    found two defects in the features it watches.
13. ~~**§3.1, by going and looking.**~~ Done 2026-08-30 (§2.16). The section
    said "Empty"; it was not. Both defects were one mistake — moderation's
    remedy was written into a column the owner controls — and finding them
    needed no list, only reading `reviewReport` against what
    `setProjectVisibility` says about itself.

14. ~~**§3.2 the moderation audit log, and the appeal.**~~ Done 2026-08-31
    (§2.17), together, because they are one conversation.
15. ~~**§3.2 the test panel.**~~ Done 2026-08-31 (§2.18).
16. ~~**§3.2 deployment history.**~~ Done 2026-08-31 (§2.19).

17. ~~**§3.1 — the four surfaces the takedown never reached.**~~ Done
    2026-08-31 (§2.20). Chosen first because it was the only open item whose
    gap between the document and the code was reachable by nothing more exotic
    than a Fork button.
18. ~~**§3.2 — a client for §2.17.**~~ Done 2026-08-31 (§2.21), in a commit
    of its own, because the two are otherwise the same sentence twice: one is
    a guard that was never written and the other is a screen that was never
    built. It turned up two more things on the way — a share token handed to
    every viewer, and a screen still quoting a decision that had been
    amended — neither of which was on any list.

19. ~~**§3.1 — the restart wedge, and the boot reconcile that should have
    caught it.**~~ Done 2026-08-31 (§2.26). Settling the naming question first
    was the right order and it changed the answer: this section and §3.1 both
    expected `ERRORED`, and writing it down was what showed that `ERRORED`
    claims the command never started, which is the one thing an abandoned run
    did do. Original note follows.

    First and not close: it is the only thing on this page that destroys
    a working feature permanently, it is triggered by deploying, and the
    product is built so that nobody is told. The stuck `BUILDING` row is the
    same bug with a softer landing and belongs in the same commit — one boot
    pass, two kinds of row. Settle §3.2's naming question first; it is an
    afternoon and the reconciler depends on the answer.
20. ~~**§3.1 — the missing budget on `POST /test`, and the export beside
    it.**~~ Done 2026-08-31 (§2.27). Ten minutes, as billed, and the argument
    for it was already written down for the identical route in §2.13.
21. **§3.2 — showing people their quota.** The cheapest thing here with a user
    on the other end of it: the numbers are already computed and already
    enforced, and the only reason nobody can see them is that no endpoint
    returns them.
22. ~~**§3.1 — the defaulted access level, and the stray comment.**~~ Done
    2026-08-31 (§2.27), in the same commit as 20 rather than after 21: they are
    one file and the same argument, and splitting them would have been two
    commits to move a paragraph and name a constant.
23. ~~**§3.2 — pagination.**~~ Done 2026-08-31 (§2.28). Last of the unblocked
    work because nothing is currently over any of the caps, which is exactly
    why it was worth doing before something is — every cap in it was a
    constant nobody would have questioned until a list went quiet.

    **That empties §3.1 and §3.2 both.** Read §3.1's opening paragraph before
    reading that as good news: it has said "Empty" three times while merged
    code was wrong, and the five defects found since were found by reading two
    shipped things against each other rather than by consulting a list.

**§3.3 gained a row rather than losing one**, for the first time since this
file existed: backups. It is there because the sweep went looking for one and
found that a `Project` exists in exactly one place on one disk, and that the
delete path is thorough and has nothing behind it.

**§3.2 was empty when this section was last edited, and §3.1 said "Empty"
alongside it.** Both were wrong within the hour, and neither needed a new
feature idea to become wrong — one item came from reading `takenDownAt`'s
three call sites against the operations that copy a project, and the other
from running `grep` for the word "appeal" over `apps/web/src`. That is the
whole method, and it is cheaper than the list it keeps refuting.

Building the two of them then turned up three more that were on no list at
all: a share token handed to every viewer of every shared project, a screen
still justifying a decision by a property §2.16 had deliberately removed, and
a fifth suite asserting on a global query. All three are in §2.20–§2.21. The
pattern is now consistent enough to state plainly: **the work found by
looking is roughly twice the work written down.**

A deliberate sweep of the whole tree the same night added nine more items and
one §3.3 row — and, usefully, confirmed a great deal. What it did *not* find
is the part worth keeping: no unguarded mutating socket event, no route
without a named access level, no orphaned endpoint but `/metrics`, no debt
markers in ~51k lines. The defects it did find cluster on one thing nobody had
thought about, which is that **this process can stop while it is in the middle
of something**, and the boot that puts the machine right has only ever looked
at containers.

**A new section exists below this one, and it is not more of the same work.**
§8 is the commercial layer — plans, entitlements, an account screen, billing,
teams — and it is there because a sweep for defects will never find it. Nothing
is wrong with the code; there is simply no product wrapped around it. It has
its own order at the end of §8, and its first item is the one that unblocks
every other: **every limit in this codebase is a constant in `env`, and a SaaS
product is one where those numbers differ per customer.** That item also closes
§3.2's "quotas are enforced and never shown", so it is not additional work so
much as the same work done once, properly.

Everything still in §3.3 is blocked on a decision or on infrastructure and
should not be started until that decision is made. Everything in §3.1 and
§3.2 is not.

**That sentence was true and incomplete, which §9 now says.** Three of §3.3's
rows and one of §8's are two things bundled together, exactly as the custom
domain row (§2.12) and the scheduled jobs row (§2.13) were. §9 splits them and
gives the four halves an order; what is left after that is blocked on a
person and not on a programmer.

This section used to close by claiming **there is nothing left on this page to
simply start**. That claim has now been wrong five times, which is enough to
stop making it. Twice the blocker turned out not to exist. Once it existed and
was an unmade decision — the cheapest kind there is. Twice a row was two things
bundled together and came off by being split. And the two items in §2.14 were
never on this page at all, which is the one worth keeping: an empty §3.2 meant
"nothing has been written down", and this document read it as "there is nothing
to do". Those are different sentences, and the gap between them turned out to
be four items wide the moment anybody went looking.

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

### §8.1 and §8.2, and the one thing not checked

`pnpm -r typecheck` clean 3/3, `pnpm -r lint` clean 3/3, 1536 server tests and
1003 web tests passing — all run, not quoted.

**None of the six migrations has been applied to any database.** Docker was not running
on this machine, so the DB-gated suites skipped, `plans` has never existed
outside the `.sql` file, the seeded `free` row has never been read by anything,
and neither has `users.quotaWarnedAt` or the new `QUOTA_WARNING` enum value.
That last one is worth naming on its own: `ALTER TYPE ... ADD VALUE` is the one
statement here with a version-dependent rule about running inside a
transaction, and the precedent it follows (`20260830233000`) was applied
against a real server while this has not been. The unit tests cover the resolution logic thoroughly against a mocked
client, and that is exactly the kind of evidence §1 already records as
insufficient for a claim about a schema: §2.14's eleven DB-gated tests had also
never been run, and every one of them failed the first time they were.

So the honest statement is: **the code is verified and the schema is not.**
That covers §2.23 through §2.26 as well — and §2.26 adds a second
`ALTER TYPE ... ADD VALUE`, the statement named below as the one with a
version-dependent rule about transactions — — and §2.24 is the one where it matters
most, because `api_keys` carries a unique index on a hash and a `TEXT[]`
column, and a unique index is exactly the kind of claim §1 already says a mock
cannot be trusted about.
The first thing to do with a database in front of you is `prisma migrate
deploy` followed by the DB-gated suites, before anything else in §8 is built on
top of it.

### The 2026-08-31 sweep

Everything in §3.1 and §3.2 dated that night came from reading the tree rather
than running it, so it is worth saying exactly what was read and what was only
inferred — a defect asserted from a grep is a hypothesis until something fails.

**Read and cross-checked:** every route in `routes/v1` against every
controller's access level; every `socket.on` in `editorHandler` against the
`requiresEdit` flag, including the two document handlers whose flag sits far
enough from the call to be missed by a naive scan; `takenDownAt`'s call sites
against every operation that copies, serves, redeems or executes a project;
`deleteProjectService` against every module that holds per-project state;
`reconcileOnBoot` against every row a crash can leave non-terminal; the rate
limiters against the routes that cost compute; every capped `findMany` against
whether anything can page past it; and every server capability against whether
`apps/web` calls it.

**Confirmed by reading the code, not by executing it:** the restart wedge is
argued from three facts each verified in the source — `runJobNow` writes
`RUNNING` before it starts, the overlap check has no age bound, and
`reconcileOnBoot` touches only containers and directories — plus one already
covered by a passing test, that `lastVerdict` ignores `SKIPPED`. The chain is
tight, and it has not been demonstrated end to end. **The first thing the fix
should produce is the test that reproduces it**, which is also the only way to
know the reconciler works: an assertion about what happens after a process
dies cannot be written by the process that died.

**Numbers as of that night:** ~25.8k lines of server source, ~23.8k of web,
~1.7k shared, against ~38.4k lines of tests. 1772 server tests passing (four
consecutive full runs against real Postgres), 994 web, `pnpm -r typecheck` and
`pnpm -r lint` clean across all three packages — the lint row for the first
time, having been red on seven pre-existing errors that nobody had run into.

### What the 2026-08-29 audit changed

Every claim above was re-checked against the source rather than re-read. All
seven commit hashes in §2.1 resolve and match their subjects; the headline
numbers reproduce exactly; every file and symbol named as a deliverable in §2
exists; and every item in §3.1 and §3.3 was genuinely absent.

One conclusion in that list did not survive the next day. The follow-mode
blocker was confirmed here on the grounds that "the awareness transport carries
a name and a colour and no cursor position". It carries a selection, and has
since collaborative editing shipped — `MonacoBinding` puts it there. The search
that produced this covered the code in this repository, where there is indeed
nothing handling cursors, and stopped at its edge; the code doing it was in
y-monaco. **An audit of what an application does is not an audit of what it
has.** See §2.10.

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

11. **Moderation authority is an `ADMIN_EMAILS` allowlist, and an operator's
    only power is to make a project private.** A role column on `User` needs a
    way to appoint the first admin, which is a bootstrapping problem that ends
    in an environment variable anyway — so the environment variable is the
    design, not the scaffolding for it. Empty means nobody, never everybody.
    The authority is deliberately the smallest one that resolves a complaint:
    deletion and account action are not granted.

    **Amended 2026-08-30.** This decision used to justify that smallness by
    saying unpublishing is "the only decision whose mistakes the person they
    were made against can undo" — and §2.16 deliberately removed exactly that.
    A takedown the owner can reverse in one request is not a takedown, so the
    safety property this reasoning leaned on is gone on purpose.

    The conclusion survives and the argument for it does not. What kept a
    wrong decision survivable was that its subject could undo it; now nothing
    does, because there is no appeal and no second operator to ask. That is
    recorded as open work in §3.2 rather than left implied here. Read this
    decision as: the authority is small because it is unreviewed, and it must
    not grow until something reviews it.
    *Changes it:* more than one operator per deployment, or a deployment whose
    operators are not the people who can edit its environment.
    `middlewares/requireAdmin.ts` is the one place to rewrite.

12. **A takedown is a different fact from a visibility setting, and gets its
    own column.** `visibility` is the owner's switch —
    `setProjectVisibility` calls it "a decision about who may read the
    source" — and moderation wrote its decision into it. One person's
    decision then sat in the other's control, which is how ACTIONED came to
    be undoable by the person it was applied to (§2.16). Two parties, two
    columns. *Changes it:* nothing short of moderation and ownership becoming
    the same authority.

13. **Removing public access belongs in the QUERY, not in the cleanup.**
    `resolveSite` and the embed's `resolveToken` filter on `takenDownAt`;
    `unpublish()` and `revokeEmbed()` run afterwards only to reclaim files,
    containers and rows. Teardown touches Docker and the filesystem and can
    fail in ways a database cannot, so a rule enforced by cleanup is a rule
    that usually holds. Learned twice before it was written down: the
    verified-domain check in §2.12 and the takedown in §2.16.
    *Changes it:* nothing. A third instance would only confirm it.

14. **Notify on the change of state, never on the state.** A job that fails
    thirty nights running is one piece of news; the second consecutive
    failure says nothing and the recovery speaks (§2.15). Sending on every
    occurrence is how a notification somebody needed becomes a filter rule,
    which restores the silence the feature was built to end while looking
    like it was fixed. Outcomes that are not verdicts on the thing being
    watched — `SKIPPED`, `ERRORED` — neither start a failure nor end one.
    *Changes it:* a class of event where every occurrence is independently
    actionable. Job runs are not one.

15. **A plan may promise more of what this platform allocates, and never
    more than the host has.** The per-account limits — projects, disk,
    assistant requests, containers at once, and the feature flags — moved to a
    `Plan` row. `MAX_CONCURRENT_CONTAINERS`, `CONTAINER_MEMORY_MB` and
    `DEPLOY_MEMORY_MB` did not, and must not: a tier claiming more memory per
    container than the machine has is a promise kept by an OOM kill in
    somebody's terminal rather than by an honest refusal, and the person it
    fails is the one who paid for it. Sell capability and capacity, not
    hardware. *Changes it:* per-plan container sizing, which is a scheduling
    problem — deciding which host a project runs on — and not a column.

16. **What a plan buys is checked where the thing is CREATED, and nowhere
    else.** `provision`, `claimDomain` and `createJob` ask; `start`,
    `runDueJobs` and every read path do not. An account that drops a tier is
    blocked at the boundary — no new databases, domains or jobs — and keeps
    everything it already has, running. The other version is one `WHERE`
    clause away and deletes a customer's work at the moment they stop paying,
    which is both the obvious implementation and the one that would end the
    product. *Changes it:* nothing short of a legal obligation to stop
    serving something, which is what moderation is for and has its own path.

17. **A credential that is not a person gets its own surface, not the
    person's.** An API key authenticates against one router and nothing else
    in the product. The alternative — a key that produces the same auth
    context as a session, with a list of routes it is excluded from — fails in
    the direction that costs everything: a route added later is reachable by
    default, and the person adding it has no reason to think about a
    credential sitting on somebody's build server. Default-deny here is
    structural rather than enforced, which is the same property §6 decision 13
    prefers in a query over a cleanup. Corollaries, both tested as absences:
    a key cannot mint or revoke keys, and a key cannot delete anything.
    *Changes it:* a use somebody actually has. Widening the surface means
    writing a route into `pub.ts` deliberately, which is the point.

18. **An operator may change what an account is allowed, and may not stop it
    being used.** §8.7 grew the moderation authority for the first time — from
    projects to people — and stopped deliberately short of suspension. Locking
    somebody out of their own work is a far larger power than making one
    project private, it has no route back that the subject can take, and
    decision 11's argument is that this authority stays the smallest one that
    resolves a complaint. A complaint is about a project. If an account has to
    be stopped, that is a decision for whoever owns the deployment, taken
    deliberately, with database access — not a button that exists because it
    seemed to belong next to the others. *Changes it:* abuse that a per-project
    takedown demonstrably cannot reach, which would also be the evidence for
    what the power should look like. Nothing yet has needed it.

---

## 7. How to keep this file true

**Update the line in the same commit as the work it describes.** A ledger
updated separately is a ledger that will eventually disagree with the tree —
which is precisely how the old plan came to list two shipped features as
missing, and how this file came to exist. It is the only rule here, and the
consolidation buys nothing if it is not followed.

**And the counts, which are lines nobody thinks they own.** Added
2026-08-31 after §1's totals sat at "Done: 90. Open: 4" through nine new items
and five shipped ones. Every entry had been updated correctly in its own
commit; the figure summarising them had not, because no single commit was
obviously the one that owned it — each could reasonably think it was somebody
else's line. So: **a derived figure belongs to whoever last invalidated it.**
If a commit adds or closes an item, it also fixes the count, even when the
count was already wrong when that commit started. The alternative is what
happened here, which is that a number stays wrong for as long as it keeps being
somebody else's problem.

---

## 8. The SaaS layer

_Added 2026-08-31 (night). Everything above this line is about whether the
platform works. This section is about whether anybody can buy it._

What is in the tree today is a working multi-tenant development platform:
containers with limits, path confinement, a third origin for user code, auth,
collaboration, deployments, scheduled jobs, moderation with an audit trail and
an appeal. What is not in the tree is a **product**. There is no plan, no
price, no account page, no way for the operator to tell two customers apart,
and no way for a customer to find out what they are allowed to do except by
being refused.

Nothing in this section is a new capability. It is the commercial layer around
capabilities that already work, and it is worth being clear that this is the
smaller half of the remaining work — which is exactly why it has never been
started.

### 8.0 The observation that orders everything else

**Every limit in this product is a constant in `env`.**

| Constant | Default | Who it is really about |
|---|---|---|
| `MAX_PROJECTS_PER_USER` | 20 | the account |
| `USER_DISK_QUOTA_MB` | 2048 | the account |
| `PROJECT_DISK_QUOTA_MB` | 512 | the account |
| `AI_REQUESTS_PER_HOUR` | 60 | the account |
| `LSP_ENABLED`, managed databases, custom domains, scheduled jobs | flags | the account |
| `MAX_CONCURRENT_CONTAINERS` | 3 | **the machine** |
| `CONTAINER_MEMORY_MB` | 512 | **the machine** |
| `DEPLOY_MEMORY_MB` | 512 | **the machine** |

A SaaS product is precisely one in which the top group differs per customer.
So the foundation of this section is **not billing** — it is entitlements.
Billing, when it arrives, is only the thing that writes one column.

That is the sequencing insight and it is worth stating plainly, because the
obvious order is the wrong one: reaching for Stripe first produces a payment
flow that has nothing to change. Entitlements first produces something useful
on day one with a single free tier and no payment flow at all — it is what
§3.2's "quotas are enforced and never shown" needs anyway, and it is what makes
comping an account, running a beta, or grandfathering an early user possible
without a deploy.

**The split in that table is itself a decision** (§6, decision 15): a plan may
promise more of the first group and must never promise more of the second. The
host has three container slots and half a gigabyte apiece; a "Pro" tier that
claims more memory per container than `CONTAINER_MEMORY_MB` is a promise the
machine cannot keep, and the failure mode is an OOM kill in somebody's terminal
rather than an honest refusal. Sell capability and capacity, not the hardware.

### 8.1 Entitlements — the keystone

**Unblocked. Everything else in this section depends on it.**

- A `Plan` catalogue with a stable string id (`free`, `pro`, `team`), a label, a
  price in minor units, and the limit columns above. In the database rather
  than in code, so an operator can change a number without a deploy — and
  seeded by a migration, so a fresh deployment has a `free` plan before its
  first signup.
- `User.planId` defaulting to `free`, plus **per-account overrides**. The
  override column is not a nicety: comping a customer, extending a trial and
  grandfathering an early user are all the same operation, and without it every
  one of them ends in somebody inventing a plan row for one person.
- `resolveEntitlements(userId)` returning the effective limits — plan, then
  override on top — cached the way `userQuotaService` already caches usage, and
  failing **open** to the free plan for the same reason that file gives: a
  quota lookup must never be why somebody's save fails.
- Every site in the table above reads it instead of `env`. `env` stays as the
  free plan's defaults, so the whole change ships as a behavioural no-op and
  can be verified as one.

The verification that matters is that nothing changes: same suite, same
numbers, with limits arriving by a different route.

### 8.2 The account screen

**Unblocked. Closes §3.2's "quotas are enforced and never shown", and is the
reason 8.1 is worth anything.**

`GET /account` returning usage, effective entitlements and the per-project
breakdown; a screen showing them. The breakdown is the half that makes it
actionable — "you are out of space" is not something anybody can act on, and
"this project is 4 GB of the 5 you have" is.

You cannot sell a plan without a screen that says what the current one gives
you, and the screen is worth building even if nothing is ever sold.

### 8.3 Warning before the wall — **shipped 2026-08-31, see §2.23**

Small, and governed by §6 decision 14. Crossing 80% of disk or project count
is a **change of state** and notifies once; being over it is a state and says
nothing further. The existing notification system took this with a new kind and
no new mechanism, as expected — the only thing it needed that was not already
there is one bit on `users` to remember which side of the line the account was
on last time.

### 8.4 Billing — Stripe Checkout and the Customer Portal

**Blocked on a Stripe account and its keys, which are the operator's to
create** — **and §9.4 splits it**: subscription state, the webhook and its
dedupe, and what a lapsed plan may do are all buildable and testable with no
account in existence. Only the two calls that create a Checkout and a Portal
session need the keys, and they sit behind a flag.

The original argument, unchanged: The code is small; the decisions are not, and three of them have a
plausible wrong answer that is also the easier one to write.

- **No card data ever touches this server.** Checkout and the Portal are
  hosted by Stripe; this codebase never sees a card number, which removes PCI
  scope rather than answering it. The Portal also covers cancel, resume, card
  update, invoice history and receipts — every one of which is otherwise a
  screen somebody has to build and get right.
- **The webhook is the only writer of subscription state.** The post-checkout
  redirect is a browser event: it can be dropped, replayed, or hit by somebody
  who never paid. The webhook is the fact. This is §6 decision 13 in another
  costume — the guarantee lives where it cannot be skipped — and the wrong
  version, granting the plan on redirect, is the one most tutorials show.
  Webhooks are at-least-once, so events are recorded by Stripe's event id in a
  table and re-deliveries are dropped on the unique index rather than trusted
  to be rare.
- **A downgrade never deletes and never seizes.** An account that drops below
  its usage — cancelled, expired, or failed payment after its grace period —
  becomes blocked at the boundary: no new projects, no growth past the free
  quota. Existing projects keep working and stay exportable. Deleting a
  customer's work at the moment they stop paying is both the obvious
  implementation and the one that would end this product, and the reason to
  write it down here is that the obvious implementation is a `WHERE` clause
  somebody adds in an afternoon.

Sequenced after 8.2 on purpose: a checkout button that leads to a plan nobody
can see the effect of is a worse first version than a free tier with an honest
account page.

### 8.5 Teams

**Blocked on 8.1, and on a pricing decision.**

A team is not sharing — sharing shipped, and `ProjectCollaborator` is what it
is made of. A team is **ownership by an organisation**: the project belongs to
the org, seats belong to the org, and a person leaving takes nothing with them.
That means every `ownerId === userId` comparison in the codebase becomes a
membership question, which is the honest cost of this item and the reason it is
last rather than first. Per-seat versus per-usage is a pricing decision, and it
is the same class as the autoscale row in §3.3: it should be made rather than
arrived at.

### 8.6 API keys and a public API — **shipped 2026-08-31, see §2.24**

**Unblocked.** `UserToken` is single-use and arrives by email; an API key is a
different object with a different lifetime — a displayed-once secret stored as
a prefix plus a hash, with scopes, a last-used timestamp and revocation. It is
what makes this platform something other systems can drive: CI that pushes a
deploy, a script that creates a project from a template, the CLI that §3.3
rules out building by hand.

*What shipped added the part this description missed*: the surface a key can
reach has to be **designed and separate**, not the signed-in one behind a
different credential. That turned out to be the whole security content of the
item, and it is §6 decision 17.

### 8.7 An operator console — **shipped 2026-08-31, see §2.25**

Overlaps §3.2's `/metrics` item and extends it: find an account, read its plan
and usage, comp it. **Not suspend it** — that half of this line was refused
when it came to be written, and the refusal is §6 decision 18.

**This grows operator authority, and §6 decision 11 says that must not happen
until something reviews it.** So the audit trail is not a follow-up commit: any
action here is written to the moderation log — which already exists, already
survives the deletion of its subject, and is already readable from a screen —
in the same transaction as the change, from the first commit. An operator who
can silently change what a customer paid for is a worse position than this
product is in today.

*What shipped differed in one place*: the trail is its own table rather than
the moderation log. Every row of that log names a project and copies the name
so the record survives the deletion; an account action has none, and fitting
one in would have meant making that column nullable to hold an event that is
not part of the same conversation. §2.25 has the argument. The rule this
section stated — audit in the same transaction, from the first commit — held.

### 8.8 Compute is the real cost and nothing meters it

Recorded rather than decided — and §9.3 says the decision cannot be made yet
for a reason worth stating: there is no number. The meter is unblocked, it is
the evidence this question needs, and it should exist before the answer does.

Recorded rather than decided. What is limited is disk and project count; what
is expensive is container-hours, and the idle reaper is the only thing standing
between a free tier and an unbounded bill. Before any price is set, settle
whether this sells capability (a plan buys features and quotas, compute is
best-effort behind the reaper) or meters compute (minutes counted, which needs
a meter, a budget and a story about what happens when it runs out). The first
is what the code is shaped for today. The second is what the hosting invoice
will eventually argue for.

### 8.9 Deliberately out of scope

So nobody reopens them by accident: metered invoicing beyond a counter; tax,
which is a Stripe checkbox and not a feature written here; SSO and SAML, which
are enterprise features that need 8.5 first; a template marketplace; and
referral or affiliate mechanics.

### Order

8.1 → 8.2 → 8.3 → 8.6 → 8.4 → 8.7 → 8.5. The first three are one week of
work, land as one coherent change, and leave the product sellable-shaped
without a payment processor in it.

**The first three are done** (§2.22, §2.23), and the estimate above was the
wrong shape rather than the wrong size: almost none of the work was the plan
table or the screen. It was deciding what a limit is *about* — the account or
the machine — and what a lapsed plan is allowed to do to work somebody has
already done. Those two questions are §6 decisions 15 and 16, and everything
after this point in §8 leans on them.

**8.6 and 8.7 are done too** (§2.24, §2.25). Five of §8's seven items shipped
the day the section was written, which says less about the pace than about the
observation in §8.0: almost all of this was already built, and what was missing
was the layer that lets it differ per customer and be seen.

**§9 amends what follows.** 8.4 is half buildable (§9.4) and 8.8 needs a meter
before it needs an answer (§9.3). The paragraph below is still right about
8.5, and about what makes this product sellable.

**What is left is exactly the two items that need somebody other than a
programmer.** 8.4 needs a Stripe account and its keys, which are the operator's
to create. 8.5 needs a pricing decision — per seat or per usage — before any of
its code means anything. Until then the honest state of this deployment is a
free tier with plans it can describe, comp, meter and warn about, and cannot
sell.

---

## 9. What is left, and what is actually blocked

Written 2026-09-01, after §3.1 and §3.2 emptied for the first time with
nothing unblocked behind them. Seven items remain across §3.3 and §8, and every
one of them is marked blocked.

**This document has been wrong about that five times** (§4 says so, and keeps
count). Twice the blocker did not exist. Once it existed and was an unmade
decision, which is the cheapest kind there is. Twice a row was two things
bundled together and came apart the moment anybody split it — §2.12 shipped
custom domains that way, and §2.13 shipped scheduled jobs out of the row that
also held autoscaling. So the useful question is not "what is unblocked" but:

> **For each remaining item, what part of it needs somebody with a credit card,
> a DNS zone or a pricing opinion — and what part is just code that nobody has
> written because the row had one word on it?**

Asked that way, four of the seven come apart. The other three do not, and
saying which is which is most of the value of this section.

### 9.0 The split, item by item

| Row | The half that needs a person | The half that is only code |
|---|---|---|
| Backup and restore (§3.3) | where backups **go** — object storage, a second disk, or a written acceptance of loss | a delete that can be undone, which is the failure mode that actually happens |
| Certificates (§3.3) | who terminates TLS, and where the account key lives | telling that terminator **which hostnames are real**, which is one endpoint |
| Compute metering (§8.8) | whether this product sells capability or sells minutes | the meter, which is the evidence the decision needs and does not have |
| Billing (§8.4) | a Stripe account and its keys | subscription state, webhook ingestion, and what a lapsed plan may do |
| Autoscale (§3.3) | a cost model | — |
| Process snapshots (§3.3) | a disk budget, and a mechanism nothing here resembles | — |
| Teams (§8.5) | per seat or per usage | — (see 9.6) |

Debugging is not in the table: §6 decision 1 defers it deliberately, and §3.3
already says the answer is to revisit the *route*, not the row.

### 9.1 A delete that can be undone — **shipped 2026-09-01, see §2.29**

The backup row's real content, separated from its destination.

`deleteProjectService` removes the container, the managed database **and its
volume**, the checkpoints, the cache volume, the deployment and its published
files, the row, and then `fs.rm(projectDir, { recursive: true, force: true })`.
It is thorough, correct, and irreversible, and the only thing in front of it is
a confirmation dialog.

**The distinction that unblocks this row: losing a disk and losing a click are
different problems, and only one of them needs a destination.** A backup answers
"the host died". A trash answers "I meant the other project", which is the one
that actually happens, needs nothing off this machine, and is the half a user
can act on. Shipping it does not make the backup row less true; it makes the
irreversible path recoverable while the destination is still an open question.

The design, with the parts that have a plausible wrong answer named:

- **Deleted is a state, not an absence.** `deletedAt` on `Project`, and every
  query that lists or resolves a project filters on it — §6 decision 13, which
  §2.20 already paid to learn: the guarantee lives in the query, never in the
  cleanup. There are more of those call sites than the takedown had.
- **What is released immediately and what is held.** A deleted project's
  container stops, its site is unpublished, its jobs stop firing, its share
  token stops redeeming — everything that costs money or serves the public goes
  at once. What is *held* is the working tree and the row. Holding the
  container to make restore instant would be paying for storage nobody asked
  for, and serving a deleted project's site for a week is indefensible.
- **A grace period, then the real delete.** Seven days, swept by the same
  timer machinery the token prune and the domain recheck already use. The
  existing `deleteProjectService` becomes the sweeper's body rather than the
  button's, which means the destructive path keeps exactly one implementation.
- **It stops counting against quota immediately.** A trash that holds somebody
  at their project limit for a week is a trash they will empty in the first
  minute, which is the same as not having one.
- **The name is freed and the id is not.** A restored project keeps its id, so
  every URL that ever pointed at it still does.

### 9.2 Telling a TLS terminator which hostnames are real — **mostly unblocked**

`resolveCustomDomain(hostname)` already exists and already answers the only
question a certificate needs answered: *is this a name this platform is willing
to serve?* It is verified by a TXT record (§2.12) and it is a row in a table.

**The decision that unblocks the row is refusing to write an ACME client.** An
account key, a challenge responder, a renewal timer and a certificate store are
four things to get right, all of them solved, and the solution is a reverse
proxy this deployment is going to run anyway. Caddy's on-demand TLS asks an
HTTP endpoint before issuing for a hostname it has never seen; that endpoint is
`resolveCustomDomain` with a status code in front of it. Roughly thirty lines,
and the blocked half stops being "build ACME" and becomes "the operator writes
six lines of Caddyfile".

Three things this endpoint has to get right, because it is the only guard
between a public listener and unbounded certificate issuance:

- **Unauthenticated, and it must be.** The proxy asks before any session
  exists. So it answers with a status code and nothing else — no body, no
  reason, no distinction between "unknown" and "unverified" — because it is a
  hostname oracle otherwise.
- **Verified only.** An unverified claim is not an address (§2.12), and issuing
  a certificate for one would let anybody claim a name and get a certificate
  attempt for it.
- **Rate limited on the same reasoning as everything else that costs.** Every
  yes is an ACME order somewhere, and a certificate authority's rate limits are
  the kind you discover by being locked out for a week.

What stays blocked: whether this deployment terminates TLS at all, and where
that key lives. That is genuinely the operator's, and it is now a config file
rather than a project.

### 9.3 A meter for compute — **unblocked, and it is the evidence 8.8 needs**

§8.8 records the question and does not answer it: does this product sell
capability, or sell minutes? It also says the code is shaped for the first.

**It cannot be answered without a number, and there is no number.** Disk and
project count are metered; container-hours, which is the actual cost, are not
measured anywhere. So the unblocked half is the meter, and the decision waits
for it — which is the right order, because a pricing decision made without
usage data is a guess that becomes a table nobody can change later.

One design decision carries this, and it is a direct lesson from §2.26:

> **Sample, do not open a session.** A `startedAt`/`endedAt` row is the obvious
> shape and it is the restart wedge again — a row with an open end, a process
> that stops existing, and a number that is wrong forever afterwards. Instead a
> sweep on the interval this codebase already runs adds elapsed seconds per
> running container to a per-user, per-day total. A restart loses at most one
> tick, nothing is ever left open, and the failure mode is a slight undercount
> rather than a project that appears to have run for three weeks.

Recorded, not billed. Nothing refuses anything on this number until §8.8 is
answered, and the account screen can show it because "you used 4 hours of
compute this month" is true and useful before it is ever a price.

### 9.4 Billing state, with the processor behind a flag — **half unblocked**

Same split §2.12 used for custom domains: everything except the part that needs
a credential somebody else owns.

What can be built and tested now, with no Stripe account in existence:

- **`Subscription` state on the account**, and the state machine that maps it
  to a `planId` — which is the only thing the rest of the codebase reads,
  because §2.22 already made every limit an entitlement lookup. Billing writes
  one column, exactly as §8.0 predicted.
- **The webhook endpoint, and its dedupe table.** Events are recorded by
  Stripe's event id with a unique index, so an at-least-once redelivery is
  dropped by the database rather than by hoping. This is testable against
  recorded payloads and needs no key: the signature check is one function with
  the secret injected.
- **The grace period and the downgrade**, which is the part §8.4 says has a
  plausible wrong answer that is also easier to write. An account that stops
  paying is **blocked at the boundary** — no new projects, no growth past the
  free quota — and keeps everything it has, working and exportable. §6 decision
  16 already settled the shape of this for plan features; this is the same rule
  reaching subscriptions, and it should be the same code.

What stays blocked: creating a Checkout session and a Portal session, which are
two calls to a live API behind a feature flag that is off. **The webhook is the
only writer of subscription state** either way (§8.4), so nothing that grants a
plan depends on the flagged half.

### 9.5 What stays blocked, and why it is not stubbornness

- **Autoscale.** Deciding how many copies of an always-on process to buy in
  response to load is a cost model. 9.3's meter is the input it is missing, so
  this row gets closer by somebody else's work rather than by its own.
- **Process snapshots.** Suspending and resuming a running process is a
  mechanism nothing in this codebase resembles, and it needs a disk budget per
  suspended project. Both halves are real. Nothing to split.
- **Where backups go.** 9.1 takes the recoverable-delete half and deliberately
  leaves this: object storage off this VM, a second disk, or a written
  acceptance that this platform loses data when its host does. **9.1 must not
  be allowed to read as closing this row**, and §3.3 keeps it open.
- **Debugging.** §6 decision 1. Revisit the route, not the row.

### 9.6 Teams, and why it stays whole

§8.5 is blocked on per-seat versus per-usage, and unlike the four above, the
split does not help: the *pricing* is the blocked half, but the *code* half is
"every `ownerId === userId` comparison in the codebase becomes a membership
question". That is not a row somebody starts on a Tuesday to unblock something
else, and starting it half-blocked produces an ownership model built around a
pricing decision nobody has made.

The honest note is that §2.22 made this cheaper than it was: entitlements are
resolved per account through one function, so an org's plan would be one more
branch in `resolveEntitlements` rather than a second billing system. The
ownership rewrite is still the cost.

### Order

**9.1 → 9.3 → 9.2 → 9.4.**

- [x] **9.1 A delete that can be undone.** Shipped 2026-09-01 — see §2.29.
- [ ] **9.3 A meter for compute.** Next.
- [ ] **9.2 A hostname endpoint for a TLS terminator.**
- [ ] **9.4 Billing state, with the processor behind a flag.**

Listed as rows and not only as prose because §1 counts checkboxes, and a
section whose items were paragraphs would have made that figure mean two
different things — which is the drift §7 was extended to stop.

9.1 first because it is the only one with a user on the other end of it who is
currently one dialog away from losing their work, and because it is the largest
of the four — the filter has to reach every query that resolves a project, and
§2.20 is the record of how many surfaces that means.

9.3 second because it is small, it has no dependencies, and every day it does
not exist is a day of data the §8.8 decision will not have.

9.2 third: thirty lines, and it converts a blocked row into a documented config
file rather than closing it.

9.4 last of the four because it is the biggest and the least useful until
somebody has an account — but it is genuinely buildable, and building it is
what makes "we got the keys" a one-day change instead of a two-week one.

**None of this makes the product sellable.** That still needs the Stripe
account (§8.4) and a pricing decision (§8.8, §8.5). What it does is make the
list honest: after these four, everything left on this page is waiting on a
person rather than on a programmer, and for the first time that will be true.
