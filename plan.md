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
2026-08-30; the notes under the table say which rows were **not** re-run that
day, and why that matters more than usual:

| Check | Result |
|---|---|
| `pnpm -r typecheck` | clean, 3/3 packages |
| `pnpm --filter server test` | **1478 passing**, 228 skipped (88 files) |
| the same, with `TEST_DATABASE_URL` set | not re-run on 2026-08-30 — see below |
| `pnpm --filter web test` | **941 passing** (71 files) |
| Debt scan (`TODO`/`FIXME`/`HACK` over `apps/`, `packages/`) | **0 hits** |

The 228 skipped server tests are the DB-gated suites (`TEST_DATABASE_URL`
unset) and the shell-quoting round-trips (`/bin/bash` absent on Windows). Both
run in CI. The DB-gated row was run rather than quoted for §2.11 and §2.12:
both put load-bearing claims in a unique index, a foreign key and a
transaction, and a mock cannot be wrong about those in any way worth trusting.

**It was not run for §2.13 or §2.14.** The Docker daemon stopped part-way
through §2.13 and never came back, which takes the test database with it. Two
consequences, both of which want clearing before either is trusted:

- §2.13's scheduled jobs are verified only as far as the 22 cron cases and the
  non-DB suites reach; its 19 DB-gated tests did not run, and its migration was
  written by hand rather than generated and diffed against a live database.
- §2.14's env-var encryption has 12 unit tests that do run, and 11 DB-gated
  ones that do not. The unit tests cover the reading logic — which is where the
  dangerous mistake would be — but the *claim*, that this column no longer
  holds anybody's credentials, is a claim about the database and is checked by
  reading the column. The fix in §2.14's second half is DB-gated too.

**Run the DB-gated suite before trusting §2.13 or §2.14.**

There is also a flake worth knowing about, since it will otherwise be
mistaken for a regression: under load the web suite fails 9–10 of its 941 at
the default 5s timeout, always the *first* test in a file and always passing
in isolation. Verified as environmental by running it on a clean checkout,
which failed the same way. `--testTimeout=20000` is green at 71/71.

**Done: 79 items. Open: 8 — four blocked, four not.**

The four blocked ones are §3.3, and none is a whole row any more: each is the
blocked remainder of one, after the unblocked half shipped. A certificate, an
autoscaler's cost model, a disk budget, and an architectural route.

**§3.2 is no longer empty, and that is the substantive change here.** It held
nothing from 2026-08-29 until now, which this document read as "there is
nothing left to simply start" — see §4, where that claim is made and has now
been wrong five times. What had actually happened is that the page stopped
being where work was found. The four items now in §3.2 came from reading the
shipped features against each other rather than from any list, and none of
them is blocked on anything.

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

## 3. Open

### 3.1 Defects — code that is merged and wrong

Empty. The three deployment defects were fixed on 2026-08-29 (§2.8), and the
last entry here — public projects with no report mechanism and no review — was
closed on 2026-08-30 (§2.11). It was never a defect so much as an unmade
decision, which is why it outlasted the three that were.

One defect has been fixed since **without ever appearing in this section**: a
viewer could duplicate a project and receive its environment variables, which
the `/env` endpoint would have refused to show them. Recorded in §2.14 rather
than back-dated into here, but worth noting where this list failed. Nobody was
going to write it down, because nobody knew — it was found by reading two
endpoints' access rules against each other, and a list of *known* defects
cannot prompt that.

### 3.2 Unblocked — work, not decisions

Emptied on 2026-08-29, when everything then in it moved to §2.8. Four items
arrived on 2026-08-30, none of them from a feature list: they are what reading
the shipped features against each other turned up. Nothing here is blocked.
Listed in the order §4 recommends.

- [ ] **Nobody is ever told anything.** The moderation queue (§2.11) and the
      scheduled jobs (§2.13) have the same failure mode, and it is the worst
      one available: silence. A report sits at `OPEN` until a moderator
      happens to open the page. A nightly job exits 1 every night for a month
      and looks exactly like one that works.

      Both features already record everything a message would need — §2.13
      went as far as keeping six run states apart *precisely* so that "it did
      not run" and "it ran and failed" would stay legible — and then tell
      nobody who is not looking. The panel in each case is honest to whoever
      opens it, which is the one person who already knows.

      The channel exists: `lib/mailer.ts` has a `Mailer` interface, a
      `setMailer`/`getMailer` seam for tests, `hasRealMailer()` for the
      install that has not configured one, and `webUrl` for linking back in.
      What is missing is anything that decides a message is worth sending —
      there is no notification model in the schema and nothing referencing
      one.

      **Design, settled 2026-08-30 before building.** Three decisions carry
      it, and each came from something already in the tree rather than from
      preference:

      **A notification is a stored record first, and mail only if mail
      happens to work.** The obvious build — call the mailer where the event
      happens — fails on this codebase specifically: `mailer.ts` falls back to
      `loggingMailer`, which in production logs an *error* per message. An
      install without SMTP would turn every failing job into error spam and
      still tell its user nothing. The row is the feature; the email is a
      transport that may not exist.

      **Notify on the CHANGE, not on the state.** A job that fails thirty
      nights running is one piece of news, not thirty. The second consecutive
      failure is not news; the recovery is. So the emitter compares a finished
      run against the one before it and speaks only on a transition — which
      needs no new column, because `ScheduledRun` history is already kept and
      pruned. Sending on every failure is how a feature meant to end silence
      produces a filter rule and re-creates it, with the added harm of looking
      solved.

      **Moderators get mail and no inbox, because they are not users.**
      `requireAdmin` identifies them by `ADMIN_EMAILS`, a config list, and
      §2.11 chose that deliberately over a role column. A configured address
      need not have a `User` row at all, so there is nothing to hang an in-app
      record on. In-app is therefore for users, and the queue notifies by mail
      — and an empty `ADMIN_EMAILS` must say so loudly, for the same reason
      the logging mailer shouts in production.

      Scope: `Notification` + `NotificationKind` (`JOB_FAILING`,
      `JOB_RECOVERED`, `PROJECT_UNPUBLISHED`), a `notificationService` whose
      `notify` never throws into its caller — a message that cannot be stored
      must not fail the job run or the moderation action that occasioned it —
      the three emitters, `GET`/`POST` under `/v1/notifications`, and a bell
      with an unread count. Mail goes only to a **verified** address:
      `emailVerifiedAt` exists precisely so that an unconfirmed address, which
      may belong to somebody else, is not sent somebody's project news.

- [ ] **Moderation has no audit log.** §2.11 gives a moderator the power to
      unpublish somebody else's project. The schema records the report and its
      status; it does not record who acted on it, when, or why. This is the
      one power in the system exercised *against* a user rather than for them,
      and it is the only one with no trail: a moderator cannot demonstrate
      they were fair, and cannot be shown to have been unfair.

- [ ] **The test command has no panel.** A project can run, deploy, and now
      schedule — but the command people type most often has nowhere to show
      its results, and nothing named `testRunner` exists in either app. The
      run output and the terminal are both already there to build on.

- [ ] **A deployment cannot be rolled back, because no history is kept.**
      `Deployment.projectId` is `@unique` — one row per project, mutated in
      place on every publish. The previous build is not retained anywhere, so
      "put back the one that worked" has nothing to put back. Last of the four
      because it is the only one needing a migration rather than a service,
      not because it is blocked.


### 3.3 Blocked on a decision or on infrastructure

Each is named with what blocks it, so none reads as ready to start.

- [ ] **Certificates for custom domains.** What is left of the row that used
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
- [ ] **Autoscale.** What is left of the row that used to say "autoscale and
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

12. **§3.2 notifications.** Next, and first for a reason: it closes the same
    silence in two already-shipped features at once, which is more leverage
    than anything else on this page. The channel is already written.
13. **§3.2 the moderation audit log**, then the test panel, then deployment
    history — which wants a migration and so goes last.

Everything still in §3.3 is blocked on a decision or on infrastructure and
should not be started until that decision is made. **The four items in §3.2
are not**, and that is the first time this has been true since 2026-08-29.

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
    deletion and account action are not granted, because unpublishing is the
    only decision whose mistakes the person they were made against can undo.
    *Changes it:* more than one operator per deployment, or a deployment whose
    operators are not the people who can edit its environment.
    `middlewares/requireAdmin.ts` is the one place to rewrite.

---

## 7. How to keep this file true

**Update the line in the same commit as the work it describes.** A ledger
updated separately is a ledger that will eventually disagree with the tree —
which is precisely how the old plan came to list two shipped features as
missing, and how this file came to exist. It is the only rule here, and the
consolidation buys nothing if it is not followed.
