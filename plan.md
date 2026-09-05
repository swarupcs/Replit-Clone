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
| `pnpm --filter server test` | **1676 passing**, 280 skipped (124 files) — no database on this machine |
| the same, with `TEST_DATABASE_URL` set | last green 2026-08-31 evening, four times. **Not re-run since §2.22**, which adds seven migrations — see §5 |
| `pnpm --filter web test` | **1055 passing** (82 files) |
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

**Done: 150 items. Open: 25 — five blocked, ten from §10 that are all
waiting on one decision (§10.1), seven from §11, which reads the sandbox
rather than the editor, and four from §12, which reads neither and asks what a
cloud machine is for. Six of §11's seven are blocked on nothing; 11.10 is
the one row §11 has produced that needs a decision before it needs code, and
12.4 is blocked on hardware rather than on anybody.**

**The Done figure was 123 and is now 148, and that is a correction rather than
this section's own growth.** By the same count §1 has always used — top-level
checkboxes in this file — 148 was already true before §12 was written; the Open
figure beside it was right, which is the tell. It is the exact failure §7's
second paragraph was added to stop, one section later and in the other column:
each commit fixed the row it owned and none of them owned the sum. Recorded
here rather than quietly changed, because a count that moves 25 in one edit is
otherwise indistinguishable from a section that added 25 items.

Open, in full, so the shape is visible without scrolling: **no defects**
(§3.1 is empty again, and read the paragraph at the top of it before believing
that), **no unblocked work in §3.2**, **nothing left of the four halves §9
split out**, **five blocked** (§3.3 — a certificate's private key, an
autoscaler's cost model, a disk budget for snapshots, a backup destination, and
an architectural route), **ten in §10 behind that same route**, **seven in
§11** (11.2, 11.4 and 11.8 shipped 2026-09-05, the day after the section was
written; 11.2 also split 11.10 out of itself, and 11.4 named the wrong
interaction while doing it — see the rows. 11.9's DOTFILES half shipped the
same day and its signing half did not, so it is still counted open: a row is
done or it is not, and half a row counted as done is how a count stops meaning
anything), and **three in §12** (12.1 and 12.2 both shipped
2026-09-05, the day the section was written; 12.2 split 12.5 out of itself on
the way, so the section is one row shorter and one row longer than it started;
12.4 is unstartable without different hardware and has been set aside).

**§12 was written on 2026-09-05 and adds four.** It is the residue of §10 and
§11 rather than a third reading of the same ground: §10 asks what Monaco cannot
do, §11 asks which of the platform's refusals expired at n=1, and §12 asks the
question neither of those can reach — what a machine in a datacentre does that
the laptop in front of you does not. Its own closing note argues that this is
the weakest of the three methods and should be trusted least, because asking
what a category has produces long lists cheaply. Two of its four rows say in
their own text that they may have no user here.

**§11 was written on 2026-09-05 and adds nine.** It asks §10's question of
the platform instead of the editor — the container's refusal list, the idle
reaper, and the fact that this server speaks plain HTTP and is reachable only
from the machine it runs on. None of its nine is blocked, which makes it the
only body of unblocked work on this page; and its first row argues that §10.1,
which blocks ten others, is **a two-item list of a three-item set**.

**§10 was written on 2026-09-03 and adds fourteen**, which is why the total
above moved for the first time in a while by something other than work getting
done. It asks a question no previous section asked: not what this platform
needs before a stranger can pay for it (§8), but what it needs before **one
person can use it instead of VS Code on their own machine**. Four of its rows
are unblocked and are about the platform rather than the editor — chiefly that
there was no way to open a folder that already exists on the disk, **which
shipped the same day it was written (§2.33)**, leaving three. The other ten
are parity rows that are all blocked on one architectural decision, and that
decision is the fifth blocked row above: §6 decision 1 named debugging and
third-party extensions as the two things that would reopen the Monaco/
openvscode-server route, and a personal VS Code requires both at once. §10 is
the first thing on this page to supply that trigger rather than wait for one.

That every open row is now blocked is a claim §9 has already been wrong about
five times, and the top of §3.1 applies to it word for word: an empty unblocked
list means nobody has looked lately, never that there is nothing to do. §8.4 and §8.5 are blocked too, on a Stripe account and on
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

### 2.30 Since (2026-09-02) — §9.3, a meter for compute

The second of §9's four halves, and the one whose whole justification is that
a decision cannot be made without it. §8.8 asks whether this product sells
capability or sells minutes, says the code is shaped for the first, and leaves
it open. **It could not have been closed either way, because there was no
number**: disk and project count are limited and measured, container-hours are
the actual cost, and nothing counted them anywhere.

**Sample, do not open a session.** The obvious shape is a row per container
with `startedAt` and `endedAt`, and it is §2.26's restart wedge wearing a
different hat — an open end, a process that stops existing, and a total that is
wrong forever afterwards. Instead a sweep adds the elapsed seconds to a
per-account, per-day row. A restart loses at most one tick, nothing is ever
left open, and the failure mode is a slight undercount, which is the right
direction for a number that might one day be a bill.

Three decisions inside that, each mutation-tested or with an obvious wrong
version:

- **Elapsed, not the interval, and capped at two ticks.** A sweep that fires
  late has still been a late sweep. But a laptop that slept for six hours, a
  paused debugger or a busy host all produce one enormous delta, and the
  container may well have been running — this process was not watching. A
  meter that guesses upward is the one nobody can defend. Removing the cap
  fails a test by name.
- **`increment`, not `set`.** The wrong one makes a day's total equal its last
  minute, and it is a one-word difference that no screen would contradict.
- **The first tick after boot records nothing.** It has nothing to measure
  from, and counting it as a full interval would make the meter read highest
  for the least stable host.

**What counts is a container, not a project**, because a project with a managed
database runs two and two is what it costs — the same reason the concurrency
cap already counts both prefixes. And **a published service counts**: it is
always-on by definition, so a meter that watched only sandboxes would be
quietest about exactly the case §8.8 is asking about.

**Recorded, never enforced.** Nothing in this codebase refuses anything on this
number, and the account screen deliberately shows it as a line rather than as a
`Meter`: a progress bar needs a limit, and rendering one would answer the
pricing question by accident. It reads "3.2 hours · not charged for", in
minutes below the hour, because the first month of a free tier is all minutes
and "0.1 hours" is a number nobody pictures.

1671 server tests and 1055 web tests pass. **This migration has not been
applied either** — see §5 — and it is the first of the seven to create a table
with a unique index the code depends on: the sweep's upsert targets
`(userId, day)` every minute.

### 2.31 Since (2026-09-02) — §9.2, the certificate row, mostly

Third of §9's four halves, and the one where the useful work was **deciding not
to build something**.

§3.3 carried "certificates for custom domains" as blocked infrastructure and
described what it would take: ACME, an account key, a challenge the deploy
listener can answer, and renewal. All four are real, all four are solved
problems, and the thing that solves them is a reverse proxy this deployment is
going to run anyway. Caddy asks an HTTP endpoint before issuing for a hostname
it has not seen — `on_demand_tls { ask … }` — and that question is one this
codebase could already answer, because `resolveCustomDomain` exists and a
domain reaches it only after its owner published a TXT record that was checked
(§2.12).

So the code half is a status code in front of a function that was already
written, and the blocked half stops being "build an ACME client" and becomes
"the operator writes six lines of Caddyfile", which is in the file.

**It is the only guard between a public listener and unbounded certificate
issuance**, so what it refuses matters more than what it allows:

- **Unauthenticated, and it has to be** — the proxy asks before any session
  exists. Which makes it a hostname oracle unless it says nothing, so it
  answers with a status code and an empty body. One 404 covers "never heard of
  it", "claimed but never verified" and "verified and then the record went
  away" alike, because telling them apart tells an anonymous caller which
  domains somebody has claimed here.
- **Rate limited**, because every yes is an ACME order somewhere and a
  certificate authority's limits are the kind you discover by being locked out
  for a week.
- **A `domain` that is not a string is refused without a query.**
  `?domain=a&domain=b` arrives as an array, which is the shape that becomes a
  type error at the database rather than a 404.

**And it found a real gap on the way in.** `resolveCustomDomain` filtered on
the verification and on the deployment, but not on the takedown or the trash —
which was never a hole in what gets *served*, because `resolveSite` filters
those itself, and became one the moment a caller asked "is this name worth a
certificate". A taken-down project's domain would have had one issued for it.
Fixed in the WHERE clause where §6 decision 13 says the guarantee belongs:
belt and braces on the serving path, load-bearing on this one.

What stays in §3.3: whether this deployment terminates TLS at all, and where
that key lives. Genuinely the operator's, and now a config file rather than a
project.

1676 server tests and 1055 web tests pass.

---

### 2.32 Since (2026-09-02) — §9.4, billing state with no processor attached

Last of §9's four, and the one where the split was cleanest: everything that
decides what an account is allowed, built and tested with no Stripe account in
existence, because the interesting part was never the API call.

**The webhook is the only writer of subscription state.** The post-checkout
redirect is a browser event — droppable, replayable, and reachable by somebody
who never paid — so granting a plan on redirect is what most tutorials show and
it is wrong. §6 decision 13 in another costume: the guarantee lives where it
cannot be skipped. Which makes `POST /api/v1/billing/webhook` the entire trust
boundary around money, and its content is what it refuses:

- **The signature is written out rather than taken from the SDK**, forty lines
  of HMAC over `${timestamp}.${rawBody}`. Not to avoid a dependency — because a
  function taking a payload, a header and a secret is testable *exactly*, with
  no key, no network and no account. 15 tests, including a v0 signature, a
  replay, a clock ten minutes ahead, and six malformed headers that would
  otherwise be 500s: `timingSafeEqual` throws on a length mismatch rather than
  returning false, so the lengths are compared first.
- **`express.raw`, mounted before the JSON parser.** The signature covers the
  bytes that were sent, and `JSON.parse` then `JSON.stringify` produces a
  different string that fails every real delivery while passing any test that
  builds its own body. So there is a test that signs a body with spaces after
  its colons and asserts the round-trip is not the same string.
- **One answer for every refusal.** An endpoint that says which half of the
  check failed is an oracle for guessing the other half, so a wrong secret and
  a replayed timestamp return the identical body — asserted by comparing the
  two responses to each other rather than to a literal.
- **No secret means no acceptance**, 503 rather than treating an unset secret
  as one that everything matches. `/billing/status` says so plainly, and says
  `checkoutConfigured: false` because nothing here can create a Checkout
  session and a button that appeared to would be lying about what happens next.

**The state machine writes one column.** `User.planId`, which §2.22 already
made every limit resolve from — a subscription that decided entitlements
directly would be a second answer to a question that has one. Both writes in
one transaction, because an account whose subscription says ACTIVE while its
`planId` says free is a customer paying for nothing.

**And a downgrade never deletes and never seizes.** §8.4 flagged this as the
row with a plausible wrong answer that is also easier to write. An account that
stops paying is blocked at the boundary and keeps everything it has, running
and exportable. The grace period is seven days and is **not restarted on
redelivery** — a webhook that arrives twice, or a second failed attempt on the
same card, must not buy another week. A `graceUntil` that is null on a
`PAST_DUE` row reads as *already expired*, not as forever, because the other
reading makes a missing date an unlimited free plan. Both of those lines were
reverted and re-run: the first fails two tests, the second fails one.

**The sweep exists because nothing else would.** Stripe sends an event when a
payment fails and another when it finally gives up, and between them is a week
in which no event arrives at all — so a deployment relying on webhooks alone
leaves a lapsed account on its paid plan for as long as the processor keeps
retrying. Hourly, one account at a time, skipping accounts already on free
(§6 decision 14: on the change, never on the state).

**On the screen**, `AccountDialog` gains a notice that says nothing for an
account with no subscription — which is every account on a deployment with no
processor — and nothing for a renewal that simply worked. Two states get a
banner, and the wording of both is load-bearing: a failed payment has to say
that nothing has happened yet and by when it will; an ended subscription has to
say that nothing was taken away, because that is what a person actually fears
at that moment.

What stays blocked, and is now genuinely all that is: creating a Checkout
session and a Portal session, two calls to a live API behind a flag that is
off. Nothing that grants a plan depends on them.

**Not verified against a database.** The `Subscription` and `BillingEvent`
tables are in a migration that has never been applied — Docker is not running
on this machine — which puts the unique index that the dedupe leans on in
exactly the class §1 says a mock cannot be trusted about. The dedupe is tested
against a mock that rejects; that it is the *constraint* rejecting is not.

1728 server tests and 1060 web tests pass.

---

### 2.33 Since (2026-09-03) — §10.2, a folder that was already there

- [x] **A project's root stopped being a function of its id.**
      `Project.localPath` holds an absolute path when the tree was already
      there; `projectRoot` answers from a registry seeded at boot. It stays
      **synchronous** deliberately — it sits under `resolveInProject`, the
      confinement check on every read and write, so making it async to ask the
      database would have put an `await` inside the guard and rewritten all
      twenty-odd callers for a lookup whose answer never changes. An empty
      registry behaves exactly as this did before, which is what makes it safe
      for every project that already exists.

- [x] **`LOCAL_FOLDER_ROOTS`, and an empty list means refuse.** That inverts
      the convention `EGRESS_ALLOW_DOMAINS` follows, on purpose: what is being
      allowed here is the host's filesystem, and an operator who has not
      thought about it has not opted in. Checked against what `realpath`
      resolves to rather than the name it was reached by — a symlink inside an
      allowed root is inside it by name and is the whole disk by content — and
      `PROJECTS_ROOT` is refused even when a named root contains it, because
      two rows over one directory disagree about who may delete it.

- [x] **The four inversions, which were the actual work.** Each of these is
      correct *because* the server made the directory, and each fails
      differently on one it did not:
      `purgeProject`'s `fs.rm` (deleting somebody's source),
      `claimForSandbox` (seizing their files for uid 1001),
      and both disk quotas (an editor refusing to save into its user's own free
      space). The chown guard went **into** `claimProjectForSandbox` rather
      than to each call site, for the reason §6 decision 13 gives about queries
      and cleanups: two callers needed it that day, and the third to be written
      would not have known to ask.

- [x] **Fork and duplicate needed nothing**, which is worth recording because
      it was expected to be a fifth case. Both build a row with no `localPath`
      and copy into it, so taking a copy of an opened folder already produces
      an ordinary server-owned project — which is the right meaning, not a
      lucky one.

- [x] **Two dialogs were saying something untrue.** The trash's "its files are
      removed from disk permanently" and the delete confirmation's "delete it
      for good" are both wrong for a folder somebody opened, in the same class
      as the mistake §2.29 fixed pointing the other way. Somebody who believes
      their folder is about to be deleted does not press the button.

- [x] **A picker rather than a path field.** A field alone means you must
      already know the path and every typo is a refusal from an allowlist you
      cannot see. It also says out loud that these are the *server's*
      directories: on a remote deployment somebody looking for their own
      laptop's `~/code` would otherwise read an empty list as a bug.

Server: 1781 passing. Web: 1071 passing. Typecheck and lint clean, 3/3.

**One thing found and not fixed**, recorded rather than left to be
rediscovered: nine tests in `useLanguageServer.test.tsx` fail on any checkout
without `apps/web/.env`, because `socketUrl` calls `new URL(import.meta.env
.VITE_BACKEND_URL)` and that is `undefined`. Not this change's doing —
verified by stashing it.

> **Corrected 2026-09-03, and the correction is the interesting half.** This
> paragraph originally said "CI sets the variable (`ci.yml`), so it is green
> there". That is **wrong**, and it was wrong in the direction that hides
> things: `ci.yml` sets `VITE_BACKEND_URL` in exactly one place, the **e2e**
> job's "Build the web app" step, and `pnpm -r test` runs under **verify**,
> which does not set it. So those nine have been failing in CI too — they are
> half of why `main` has been red since 2026-08-29.
>
> The claim was made by grepping `ci.yml` for the variable, finding a hit, and
> not checking which job it was in. Which is the same mistake this file keeps
> recording in other people's code: a symbol found is not a symbol in the
> right scope. Fixed in §2.37 by defaulting it in the test setup, so the suite
> stops depending on an environment file at all.

### 2.34 Since (2026-09-03) — §10.3, one account

- [x] **`SINGLE_USER_EMAIL`, and the account is provisioned at boot.** Unset —
      the default — and nothing changes. Set, and this server has exactly one
      account, created from that address, verified on the way in because there
      is nothing to verify about a string the operator typed into their own
      configuration.

- [x] **The routes that create or recover an account are not mounted.** Signup,
      password reset, email verification and GitHub *sign-in* are absent rather
      than present-and-refusing, which is §6 decision 17's shape — a rule
      enforced inside each controller is one the next route somebody adds does
      not know to ask about. The test asserts **404, not 403**, because that
      difference *is* the feature.

      Sign-in itself stays, and that is not a compromise: every route in this
      product authenticates through a session, and a server that issued one to
      anybody who asked would be an unauthenticated server on whatever network
      it can be reached from. "Personal" is about who the accounts are for, not
      about whether the door has a lock.

- [x] **The environment replaces the reset route, which it had to.** Removing
      "forgot password" removes the way back into a locked account, so boot
      *rewrites* the password whenever `SINGLE_USER_PASSWORD` is set: the way
      back in is to edit the environment and restart. That is available to the
      one person who runs this and needs no mail server, no token table and no
      inbox — and a personal deployment usually has no outbound mail path, so
      the reset route was never a way back in there anyway.

- [x] **The creation boundary, at the two places a `User` row is made.**
      `registerUser` and the GitHub upsert, which is where §6 decision 16 says
      a limit belongs. Belt to the routing's braces: the handlers are already
      unreachable, and decision 17's argument is that a structural default-deny
      should survive somebody putting a route back.

- [x] **The sign-in form stops linking to 404s.** `/auth/providers` grew a
      `singleUser` flag and lost its `githubStatus` name, since it had stopped
      being only about GitHub. GitHub reports false in that mode whatever is
      configured — signing in with it *creates* an account. Connecting GitHub
      to reach repositories is a different consent on a different router and is
      untouched, which decision 7 already keeps apart.

Server: 1798 passing. Web: 1071 passing. Typecheck and lint clean, 3/3.

### 2.35 Since (2026-09-03) — §10.4, limits about a machine nobody shares

- [x] **Zero means unlimited, and a `personal` plan sets every allocation to
      it.** A sentinel rather than a very large number or a nullable column,
      because the columns are non-null integers and every consumer compares
      them arithmetically. The rule also already existed unwritten:
      `isNearQuota` has always guarded on `limit > 0`, because a meter over a
      limit of zero means nothing.

      The one thing it costs is that "zero projects allowed" becomes unsayable.
      Nothing wants to say it — a plan permitting nothing is an account that
      cannot be used, which is suspension, and §6 decision 18 puts that outside
      what an operator may do.

- [x] **All five enforcement points learned it**, and each kept its own
      comparison: a project COUNT is refused at `>=` and a byte total only past
      `>`. A helper that hid that difference would have made one of the five
      silently off by one, which is why `isUnlimited` is a predicate and not a
      comparison.

- [x] **Every case is tested twice.** The dangerous failure here is not
      "unlimited did not work" — it is an exemption written slightly too wide,
      quietly removing the limits from every ordinary deployment while no test
      fails. So each of the five asserts the personal plan is unbounded *and*
      that the free plan still refuses.

- [x] **`SINGLE_USER_EMAIL` answers a question `NODE_ENV` was standing in
      for.** The development/deployment split on `CONTAINER_MEMORY_MB` says so
      itself: a deployment packs other people's projects onto a VM, and a
      developer running this locally "is the only tenant... nothing is shared,
      so there is nothing to protect the headroom from". A single-user
      deployment is the second case wearing the first's clothes, so it now
      takes the development figures — 2048 MB and 2 CPUs rather than 512 and a
      half.

- [x] **§6 decision 3 re-read, and half of it overturned.** LSP now defaults
      ON for a single-tenant deployment. The reason for off-by-default is
      entirely about a shared machine — the image size is "paid on every cold
      start by people who never open a `.py` or `.go` file" — and at n=1 there
      are no such people. The **memory threshold is not relaxed**: that one is
      about an OOM kill in somebody's own terminal, and it costs them exactly
      as much when they are the only user.

- [x] **The account screen stopped drawing a full red bar for "no limit".**
      `limit <= 0` produced a 100%-exception meter, which said the precise
      opposite of what is true. A bar is a picture of how close you are to a
      wall; where there is no wall there is no bar.

- [x] **A latent fragility fixed on the way.** `personalPlan` used
      `.catch()` on a lookup that can throw *synchronously* — a client
      generated before this plan existed does exactly that — and a synchronous
      throw happens before there is a promise to attach a handler to. try/catch
      instead, so "fall back rather than fail" is true rather than intended.

Server: 1814 passing. Web: 1071 passing. Typecheck and lint clean, 3/3.

### 2.36 Since (2026-09-03) — §10.5, what has no second person

- [x] **One module, `config/deploymentMode.ts`, and one decision.** §10.5 asked
      for this as a single row because it is one judgement made a dozen times,
      and leaving it implicit is how a personal deployment ends up shipping a
      report queue.

- [x] **Derived from `SINGLE_USER_EMAIL`, not a second flag** — and that is the
      substantive choice. None of what it turns off is a preference; each is
      dead by **arithmetic**. A share link is redeemed by signing in and
      becoming a collaborator, and the one account that can sign in already owns
      the project. A report needs a reporter and a separate operator, which §6
      decision 11 requires be different people. The console administers
      accounts, and there is one. The gallery lists what *other* people
      published. A flag would imply these could sensibly be switched back on.

- [x] **Not mounted, again.** Sharing, moderation, the appeal, the operator
      console and the gallery are absent rather than refusing, matching §10.3.
      The test asserts 404 across all of them, and — the more useful half —
      asserts that templates, trash, tree, export, embeds and the local-folder
      routes still answer, because the failure this guards against is an
      exemption written by *theme* rather than by reasoning.

- [x] **`/auth/providers` carries the capability set**, so the app does not
      draw a Share button or an Explore section whose endpoint is a 404 —
      the same argument that removed the signup link in §2.34. The client
      defaults every capability to **on** while the query is in flight and if it
      fails: defaulting the other way would blink those controls out of every
      ordinary deployment on every page load, and hide them permanently
      wherever the request hiccuped.

**One deviation from §10.5's list, recorded rather than followed silently.**
That list had **API keys** among the things with no user at n=1, and on
reflection that is wrong: a personal deployment with a build server is an
ordinary setup, and §6 decision 17 already makes the key surface default-deny
and tiny. They stay. **Embeds** stay for the same kind of reason — putting your
own project in your own blog post is something one person does alone, and the
audience was never an account here.

**And one thing that looks dead and must not be touched.** Collaborative
editing has no second participant at n=1, but `collabService` is not switched
off: the server owns writing a file while its document is live and the editor
suppresses its own writes for those paths, so removing it would not simplify
anything — it would stop saving.

Server: 1821 passing. Web: 1074 passing. Typecheck and lint clean, 3/3.

### 2.37 Since (2026-09-03) — the two reasons `main` was red

Not §10 work. Both were found by pushing §10 and reading the CI that came
back, and both were failing on `main` before this branch existed — since
2026-08-29, across every run.

- [x] **A page asserted as an array.** `projectAccessService.test.ts` did
      `expect(await listAccessibleProjects(mate)).toHaveLength(1)` on a
      function that returns `Page<ListedProject>`. §2.28 gave every list a
      cursor and updated the call site *twenty lines below* — which
      destructures `.items` and passes — while missing two above it.

- [x] **An E2E selector for markup deleted a week earlier.** Two flows waited
      20 s each for `.ant-segmented-item`. The template picker stopped being a
      `Segmented` in `4b104f7` (2026-08-26); `TemplatePicker.tsx` says so in
      its own comment. Now keyed on `[data-template-id]`, an attribute the
      card already carried, rather than on the visible label — the label is
      what moved last time.

- [x] **Nine tests that needed a file `.gitignore` hides.** `socketUrl` does
      `new URL(import.meta.env.VITE_BACKEND_URL)`, which throws
      `Invalid URL: undefined` when it is unset. Defaulted in the vitest setup
      instead: a unit suite should not need an environment file to run.

**What the three have in common is the finding.** Each was invisible without
some piece of apparatus — a database, Docker and a browser, an untracked
`.env` — and each therefore failed only where nobody was looking. Two of them
are the *same mistake as §2.28's and §2.14's*: a shape changed, most call
sites were updated, and the ones that were not could not fail on the author's
machine.

The third is worse, and it is mine. §2.33 asserted "CI sets the variable, so
it is green there" on the strength of grepping `ci.yml`, finding a hit, and
not checking **which job** it was in — it is in `e2e`, and the failing suite
runs under `verify`. A symbol found is not a symbol in scope. §2.33 now
carries the correction rather than the claim.

Verified against the real thing rather than argued: Postgres installed and
running locally, migrations applied, and the whole of `pnpm -r test` run the
way CI runs it — **with no `apps/web/.env` present**, which is the condition
that had been quietly flattering every previous local run.

Server: 2081 passing (0 failing, 9 skipped). Web: 1074 passing. Typecheck and
lint clean, 3/3. Both apps build.

### 2.38 Since (2026-09-05) — §12.1, a workspace that is not every workspace

First of §12, and the only one of its four that is about the reason to keep a
workspace on a server at all. Every project container was sized from one pair
of numbers — `CONTAINER_MEMORY_MB` and `CONTAINER_CPUS` — so the Rust workspace
that wants 8 GB and the eleven that idle at 512 MB were all the same size.

**§6 decision 15 is what this had to be built around, and it is nearly but not
quite in the way.** That decision says a plan may promise more of what the
platform *allocates* and must never promise more of what the host *has*: a tier
selling more memory per container than the machine can give is a promise kept
by an OOM kill in somebody's terminal. It forbids *selling* a size. It does not
forbid one workspace differing from its neighbour, and the two had been treated
as one question because only the first was ever asked.

So a size here is deliberately **not a plan entitlement**. It is an allocation,
measured against what is running at the moment somebody asks for it — a sum
this server can actually do, rather than a promise made in advance to somebody
who will collect on it later. Concretely:

- **The budget is the host's, asked of Docker rather than of `os.totalmem()`,**
  because the number that matters is the one the daemon enforces against — in a
  VM and on Docker Desktop those differ, and the daemon's is the one that kills
  a container. Less `HOST_MEMORY_RESERVE_MB` (1024) for this server, Postgres,
  the egress gateway and the OS, which all live in the same memory the
  sandboxes are handed out of.
- **Committed, not used.** A container sitting at 40 MB of its 2048 still holds
  2048 against the next OOM. Sizing the next workspace against `docker stats`
  would oversubscribe the host by exactly however idle everything happened to
  be at that moment.
- **Checked again at the start**, not only when the size is set: something else
  may have started in between, and §6 decision 13 says the guarantee belongs
  where it cannot be skipped. A default-sized workspace is exempt, because that
  is what `MAX_CONCURRENT_CONTAINERS` already rations and failing it here would
  refuse projects that worked before this existed.
- **Owner, not editor.** A collaborator with write access decides what runs in
  the container; how much of the host it holds is a decision about every other
  workspace on the machine.
- **It does not resize what is running, and says so.** Docker will move a
  running container's cgroup, but the process inside has already read
  `/proc/meminfo` and sized its heap — a Node process told it had 512 MB does
  not start using 8 GB because the limit moved underneath it.

**The screen shows the budget, not just the size.** A field containing "2048"
is not something anybody can act on; the question somebody opens it to answer
is "can I give it more", which needs what the host has and what is already
spoken for. This is §2.22's argument — a limit you discover by hitting it —
applied one section later.

**§12.1 named the second call site and it was right to.**
`containerManager.ts:1187` computes the stats panel's ceiling from the same
constant, and a per-workspace size that had not reached it would show every
project a limit that is not its own.

**A defect found by the existing tests rather than by the new ones**, which is
the §3.1 pattern exactly. `custom` was computed as `memoryMb !== null`, and
every mock in the new suite sets those columns to an explicit `null` — so
`undefined`, which is what a caller that selected neither column gets, was a
state the tests never produced. `undefined !== null` is true, so every
default-sized project read as custom and took a capacity check it was meant to
be exempt from. Six container tests failed on a `docker.info` that was never
supposed to be reached. Fixed with `?? null`, and both states now have a test.

Five mutants, all caught: counting the project being resized against itself,
ignoring what is committed, treating a vanished project row as free memory,
never reporting a size as custom, and writing a size without measuring it.

Server: 1916 passing, 296 skipped — no database on this machine, so the
DB-gated suites did not run; §5 is the standing note on what that does not
prove. Web: 1117 passing. Typecheck and lint clean, 3/3.

The one red file is `localRoots.test.ts`, which cannot create a symlink
(EPERM) on this Windows host and fails identically on a clean checkout —
confirmed by stashing this branch and running it alone. Environmental, and
not this work's.

---

### 2.39 Since (2026-09-05) — §12.2, the install nobody watched

Second of §12, and the cheap one: `warmStart` already answered half of this and
the mechanism it needed was all present. What it does is skip an install that
would have changed nothing. What it could not do is anything about the case
where the install *would* change something — pull a branch that adds a
dependency and the next start pays for a full resolution with somebody watching
the terminal, after the machine sat idle for twenty minutes.

So: every fifteen minutes, for workspaces that are already running, if the
dependency fingerprint has drifted from the stamp, run the install now and
stamp it. The next start then takes the warm path and nobody watched anything.

**The whole design is about when NOT to stamp**, because the two directions
cost wildly different amounts. A prebuild that does not happen costs a minute
somebody was going to spend anyway. A stamp claiming an install that did not
happen makes the next start skip installing and serve against dependencies that
are not there — silently, which is the failure `warmStart`'s own note says it
exists to prevent. So the stamp is withheld when the install exits non-zero,
when it throws, when it is abandoned at the timeout, and — the subtle one —
**when the fingerprint moved while the install was running**. An install takes
minutes and a lockfile can move underneath it; stamping the value read before
the run would vouch for an install that never happened for the files as they
now stand.

**It reuses `splitStartCommand` rather than reimplementing the parse**, and
that is load-bearing rather than tidy. That function's allowlist is the only
thing standing between this and running the *serve* half of somebody's command
in the background. A command it cannot take apart with certainty returns null
and nothing is prebuilt — a project carrying `./deploy.sh && npm start` is left
alone, which is the right answer and not an accident.

**A prebuild that fails tells nobody**, deliberately. Nobody asked for the
work, so a notification about it failing converts a saved minute into an
interruption — §6 decision 14's argument one step on. It is a log line and
three counters (`prebuilds_completed`, `_failed`, `_abandoned`), and
`prebuilds_completed` against `runs_install_skipped` is how much of the warm
path was earned here rather than by nothing having changed.

**One at a time across every project**, because the premise is that this runs
while the machine is quiet, and a background task that makes the foreground
slower is worse than no background task. Not run on boot either: a restart is
the one moment several containers come up together.

**What it deliberately does not do is start a stopped container**, which is the
half that is a decision rather than a line of code — it fights the idle reaper,
it spends memory the capacity gate is rationing, and on a plan whose workspaces
never sleep (§11.4) it would leave them running. **§12.5 is that row**, split
out here the way §11.2 split out §11.10, so this entry cannot be read as having
closed it.

Six mutants, all caught: stamping a failed install, stamping the pre-install
fingerprint, running a command it could not take apart, prebuilding a trashed
or taken-down project, ignoring a deleted `node_modules`, and prebuilding a
workspace that is not running.

Server: 1936 passing, 296 skipped — no database here. Web: 1117 passing.
Typecheck and lint clean, 3/3. `localRoots.test.ts` stays red on this Windows
host over symlink EPERM, identically on a clean checkout.

---

### 2.40 Since (2026-09-05) — the lockfile decides, not the code

Found while reading the creation path for §2.41, by the method §3.1 keeps
recommending: two shipped things read against each other.

`warmStart` fingerprints `pnpm-lock.yaml` and `yarn.lock`, and its
`INSTALL_PREFIXES` knows how to skip `pnpm install` and `yarn install`. But
`detectStartCommand` emitted `npm install && npm run <script>` whatever had just
been cloned — so **nothing in this codebase ever produced the commands the warm
path was written for.** Three consequences, all real:

- The lockfile was ignored, which is the entire point of a lockfile: you got
  whatever npm resolved today rather than what the repository pinned.
- A `workspace:*` dependency failed outright. npm cannot resolve the protocol.
- Even a correct `pnpm install` would have died with command-not-found, because
  neither pnpm nor yarn was in the node image — **although that image already
  set `PNPM_HOME` and `YARN_CACHE_FOLDER`**, so it was written expecting them.
  They were simply never installed.

So `detectPackageManager(files)` reads the lockfile, `detectStartCommand` takes
the manager, and the image enables corepack with both pinned and downloaded at
**build** time, so a project's first install does not also pay to fetch its
package manager. `yarn <script>` and not `yarn run <script>`: the other form is
a usage message rather than anything a person can act on.

**Fixed at both call sites, not one.** `localFolderService` had the identical
bug and is the worse of the two — a folder somebody already had is their real
working tree with whatever they chose years ago, where a fresh clone at least
tends to be recent.

Where more than one lockfile is present, the newer tool wins: that means a
migration nobody finished, and a stale `package-lock.json` left behind by a move
*to* pnpm is the common case while the reverse is not.

Four mutants, all caught, including reverting the whole thing to npm.

---

### 2.41 Since (2026-09-05) — a starter is pinned; "Latest" is not

A committed starter directory is frozen at whatever was committed: ask for React
today and you get the React of the day somebody added the folder. So the
template picker gained a second choice — **Starter** or **Latest** — where
Latest runs the tool the ecosystem actually publishes (`npm create vite@latest`,
`create-next-app@latest`) and builds the project from what it produces.

**The reason this is a service and not three lines in `createProjectService` is
a decision this repository already took once and undid.** The original code
shelled out to `npm create` on the **host**; the comment at
`projectService.ts:82` still records why it was removed — an arbitrary command
outside any sandbox, needing the network, producing a nested directory so the
bind-mount root and the app root disagreed by one level. Running the scaffolder
**inside the project's container** answers all three without giving up any of
what the starter copy bought. `importRepository` is the precedent and this
follows it closely.

**Creation stopped being synchronous, for this path only.** A scaffolder plus an
install is minutes; an HTTP request that waited would be killed by a proxy or a
browser long before it finished. So `POST /projects` returns `201` immediately
with the row saying `SCAFFOLDING`, and the dashboard polls — **and only while
something is actually being built**, so an idle tab is not a background load.
(That poll did not run at all in the first version. See below.)

**The reconcile was written with it rather than after somebody noticed.** A row
left `SCAFFOLDING` is a container exec this process was awaiting, and nothing
survives the process to finish it or to notice; without `reconcileScaffolds` the
dashboard says "Setting up" for ever. That is the third appearance of the shape
§2.26 already fixed twice, for scheduled runs and for deployments, and the first
time it was built with the boot pass from the start. Its message says what is
and is not known: the server restarted, and whatever the scaffolder had finished
is still in the project.

**The commands live in a table and are argv arrays.** A recipe is genuinely data
— what `npm create vite@latest` produces, and which flags it accepts, change
without anybody here deploying — but it is handed to `docker exec` as an array
and is never seen by a shell, which is the whole of what keeps a table of
commands from being a remote code execution surface with extra steps. **No route
writes that table.** A user picks a template and a variant; they never pick a
command, and the schema refuses a `variant` that is not one of two words.
`parseRecipe` is the boundary and it is tested as one: a bare string, a nested
non-string, an empty step and an empty recipe are each refused rather than
reaching `docker exec` as `undefined`.

**A failed scaffold fails the project and says why, in the scaffolder's own
words.** It does not quietly substitute the pinned starter: handing somebody a
different, older project than the one they chose is worse than telling them it
did not work. "npm ERR! network timeout" says try again; "creation failed" says
nothing anybody can act on. The dialog offers **Try again** — which empties the
tree first, because a half-finished scaffold leaves files behind and
`npm create` refuses a directory it considers non-empty — and **Delete**,
because those are different decisions and only the person knows which applies.

Only six templates offer it, and the UI asks the **database** which rather than
carrying a list: a recipe turned off because upstream changed a flag also
removes the option that would now fail. For `go-http` or `static-html`, "latest"
would be a control that does nothing.

Seven mutants, all caught, including carrying on past a failed step, reconciling
the wrong rows on boot, and letting a non-string reach `docker exec`.

**Two defects shipped in the first version of this, and both are worth keeping
on the page, because neither was the kind of mistake tests were going to find.**

**The dashboard never learned the status.** `scaffoldStatus` was added to the
schema, to the API type and to three places in `Dashboard.tsx` — and left out of
the `select` in `listAccessibleProjects`, four files away. So the field never
reached the client: the poll above never started, the disabled card was never
disabled, and the failure dialog was unreachable. A project built with Latest
rendered as an ordinary card and opened onto an empty editor. Nothing failed.
Typecheck was clean because `Project.scaffoldStatus` is optional in the shared
type, and an absent optional field is exactly what an unfinished project looks
like. `ListedProject` now declares it **required**, so an omitted `select` key
stops compiling at `toPage` — which is the only guard that survives somebody
adding the next column in a hurry.

**Both new migrations named the Prisma MODEL rather than the table.**
`ALTER TABLE "Project"` — but `Project` carries `@@map("projects")`, so it is
not a relation Postgres has ever heard of. The first `migrate deploy` failed on
`relation "Project" does not exist`, and it failed on **§12.1's** migration
first, which had been sitting committed and green. Typecheck, lint and 1970
tests do not read `migration.sql`; only Postgres does, and until this week
nobody had run it. `ScaffoldRecipe` also gained the `@@map("scaffold_recipes")`
every other table here has.

Server: 1984 passing, 296 skipped. Web: 1135 passing. Typecheck and lint clean,
3/3. `localRoots.test.ts` stays red on this Windows host over symlink EPERM,
identically on a clean checkout.

**Verified against a real database and real containers on 2026-09-05**, which
is what the first version of this paragraph said was missing.

- All 35 migrations applied; `migrate status` clean; six recipes seeded.
- **`react-vite` with Latest: SCAFFOLDING → READY in 31s**, and it produced
  **Vite 8.2.2 against the committed starter's 6.1.0** — two major versions,
  which is the whole argument for the feature stated as a number.
- `react-vite` with Starter: READY in 1.6s, and `diff -rq` against the template
  is empty. The path this change was not allowed to alter did not alter.
- **`nextjs-ts` with Latest took 289 seconds.** The flags seeded here are still
  the ones `create-next-app` accepts, and five minutes is the async decision
  above justified rather than argued: a request that waited would have been
  killed several times over.
- A step exiting non-zero left the project FAILED with the command's own stderr
  and no start command. **Try again** on that project emptied the tree, rebuilt,
  and cleared the log.
- A row stranded in SCAFFOLDING across a restart came back FAILED, with the
  message that says what is and is not known.

**One thing the real run found that no test would have.**
`npm create vite@latest . -- --template no-such-template` **exits 0** and
silently scaffolds a vanilla TypeScript project. So "a failed scaffold fails the
project" is exactly as true as the scaffolder's exit code, and for a bad
template name upstream does not consider that a failure. Nothing here is wrong,
but the guarantee is narrower than the sentence sounds, and the recipes are the
only thing standing between a user and a project that is quietly not what they
asked for. That is an argument for the recipe table being seeded and not
user-writable, which it is.

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

- [ ] **Certificates for custom domains.** **Split by §9.2, and the code half
      shipped 2026-09-02 (§2.31).** What is left here is whether this
      deployment terminates TLS at all and where that key lives — a Caddyfile
      and a decision, not a project. What is left of the row that used
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

      **§10 supplies the trigger.** Written 2026-09-03, it asks what this has
      to be for one person using it instead of VS Code, and a personal editor
      requires debugging *and* third-party extensions — both halves of decision
      1's stated revisit condition, at once. It also recounts Route A's price
      at n=1 and finds two of the four rewrites have no user. The row stays
      here and stays blocked; what it is blocked on is now §10.1, which is a
      decision somebody can take in an afternoon rather than an absence.

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

**None of the seven migrations has been applied to any database.** Docker was not running
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

   **Revisit requested 2026-09-03 — see §10.** Not because anything here was
   found wrong, but because the trigger this decision names has arrived from a
   direction it did not anticipate: not one feature becoming decisive, but the
   product being aimed at a single seat, where debugging and the user's own
   extensions are both table stakes. §10.0 also re-prices Route A for that
   target — the multiplayer layer and the assistant, two of the four rewrites
   this decision weighs, have no user at n=1. The decision stands until §10.1
   is answered; it is now the only thing ten other rows are waiting on.

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

**Split by §9.4, and the buildable half is built** (2026-09-02 — see §2.32):
subscription state, the webhook and its dedupe, the signature check, the grace
period and the downgrade all shipped, tested, with no Stripe account in
existence. **What is left of this row is the two calls that create a Checkout
and a Portal session**, which need keys that are the operator's to create.
Nothing that grants a plan depends on them — the webhook is the only writer
either way — so this row no longer blocks anything but the button.

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

Recorded rather than decided — and the reason it could not be decided was that
there was no number. **There is one now** (§2.30, shipped 2026-09-02):
container-seconds per account per day, sandboxes and published services both,
recorded and not enforced. This question is no longer blocked on engineering.
It is blocked on somebody letting the meter run long enough to argue from.

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

### 9.2 Telling a TLS terminator which hostnames are real — **shipped 2026-09-02, see §2.31**

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

### 9.3 A meter for compute — **shipped 2026-09-02, see §2.30**

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
- [x] **9.3 A meter for compute.** Shipped 2026-09-02 — see §2.30.
- [x] **9.2 A hostname endpoint for a TLS terminator.** Shipped 2026-09-02 — see §2.31.
- [x] **9.4 Billing state, with the processor behind a flag.** Shipped 2026-09-02 — see §2.32.

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

---

## 10. The personal IDE

Written 2026-09-03, and it is not more of §8. §8 asks what has to exist around
this platform before a stranger can pay for it. This section asks the opposite
question — **what has to exist before one person can use this instead of VS
Code on their own machine** — and the two lists disagree about more than they
agree about, because half of §8 has no user when there is only one of you.

The starting position is much better than it looks from §3. The parity ledger
(§2.6) is thirteen of thirteen: Monaco with its options exposed, preview tabs
with MRU `Ctrl+Tab`, breadcrumbs, outline, peek, `Ctrl+T`, zen mode, git gutter
and tree decorations, hunk staging, merge-conflict resolution, a keybinding
registry with chords and user overrides, a command palette, quick open,
project-wide search **and replace**, multiple terminals, a problems panel, two
hand-checked themes, and language servers for Python and Go. Nothing below is
about the editor being unfinished. It is about the four or five things VS Code
does that Monaco structurally cannot, plus the platform assumptions that stop
making sense at n=1.

### 10.0 The observation that orders everything else

**This is a route decision wearing a feature list.**

§6 decision 1 chose Monaco over openvscode-server, and — unusually for that
section — it names its own revisit trigger precisely:

> *Changes it:* debugging becoming the reason people choose something else, or
> running the user's own extensions becoming a requirement. Monaco cannot reach
> the second at all.

A personal VS Code makes **both** of those requirements at once. So this
section does not add rows to a Monaco roadmap. It re-opens the route, exactly
as §3.3's Debugging row already says it should ("Revisit the route, not the
row"), and it is the first thing on this page that has ever supplied the
trigger rather than waiting for one.

**And the price of Route A is not what decision 1 priced it at.** That decision
costed openvscode-server as putting four things behind a rewrite: the
multiplayer layer, the assistant, the run control and the preview. Recount them
for one person:

| What Route A would cost | At n=1 |
|---|---|
| the multiplayer layer — Yjs docs, `MonacoBinding`, awareness, remote cursors, presence, follow mode | **no user.** There is nobody to follow |
| the assistant — `AiPanel`, `propose_edit`, the diff-review flow | **not a rewrite.** In VS Code an assistant is an extension, and the good ones already exist |
| the run control — `RunControl`, `runStore`, the dev-server probe | **real work.** An extension with a webview, and it is not free |
| the preview — the third origin, the preview token, the iframe | **real work,** and the same shape: port forwarding plus a webview |

Two of the four evaporate and two survive. That is a materially different trade
from the one decision 1 weighed, and it is a different trade *because the
product changed*, not because anybody found a new library. **Decision 1 is not
wrong; it was answered for a multiplayer SaaS, and this section is asking it
for a single-seat editor.**

So: everything in 10.6–10.14 below is **blocked on 10.1**, and building any of
it on Monaco first is work Route A would throw away. Everything in 10.2–10.5 is
**unblocked under either route**, because Route A does not give you any of it —
openvscode-server ships an editor, not a container platform, and every one of
those four is about the platform underneath.

---

### 10.1 The route — the one decision this section is blocked on

- [ ] **Settle Monaco versus openvscode-server for the single-seat target.**
      Not a code change and not a research task: the arguments are all written
      down already, in §6 decision 1 and in the table above. What is missing is
      somebody choosing, and the choice is between two honest positions:

      **Route A — openvscode-server.** Debugging, extensions, tasks, snippets,
      settings files, the diff editor, timeline, multi-root, notebooks and
      terminal profiles all arrive at once, because they are VS Code and this
      stops re-implementing it. Costs: rebuild run control and preview as
      extensions, drop the collaborative layer (or keep this app beside it for
      the projects that want it), and accept that the editor is no longer a
      thing this repository controls.

      **Route B — stay on Monaco.** Everything in 10.6–10.14 is built by hand,
      one at a time, and 10.7 is never reachable at all: **Monaco cannot run VS
      Code extensions, and no amount of work changes that.** Decision 1 says so
      in its last sentence.

      Route B is defensible if the multiplayer layer is the point of this
      product and the personal use is a side effect. Route A is defensible if
      the personal use is the point. What is not defensible is building
      10.6–10.14 by hand *while undecided*, which is the failure this row
      exists to prevent.

---

### Unblocked under either route — the platform, not the editor

These four are what "personal" actually changes, and none of them is a VS Code
feature. Route A does not deliver any of them.

- [x] **10.2 Open a folder that is already on the disk.** Shipped 2026-09-03 —
      see §2.33. The prediction in the paragraph below was
      right about where the work was: almost none of it was the mount, and
      almost all of it was the four places that assume this server made the
      tree.
      The largest structural item here. Today a workspace is a `Project` row in Postgres
      with a working tree the server created under `PROJECTS_DIR`, reached by
      picking a template (`apps/server/templates`, thirteen of them) or by
      importing a GitHub repo. There is no path from "I have a directory at
      `~/code/thing`" to "it is open in this editor" — every route into the
      file tree goes through project creation.

      For a personal IDE that is the *only* way in that matters. What it needs:
      a project whose tree is a bind mount of a path the operator names rather
      than a directory this server owns, the confinement rules re-derived for a
      root the server did not create, and a decision about what
      `deleteProjectService` means for such a project — almost certainly "unlink
      the row, never touch the tree", which is a different code path and not a
      flag on the existing one.

      Note what this quietly rules out and check it before starting: the disk
      quota (`assertUserDiskQuota`, `diskUsageService`) walks a tree it assumes
      it owns, and checkpoints snapshot into a sibling directory.

- [x] **10.3 A single-user mode.** Shipped 2026-09-03 — see §2.34. Signup, email verification, password reset,
      refresh-token rotation with a reuse grace window, share tokens, embed
      tokens, collaborator roles and the whole `assertProjectAccess` ladder are
      correct and load-bearing for a public deployment, and they are ceremony
      for one person on a laptop. The ask is not to delete any of it: it is one
      documented mode in which a single account is provisioned at boot from the
      environment and the auth surface is not reachable from the network.

      Do it as configuration and not as a second code path — §6 decision 13's
      reasoning applies exactly: a rule enforced by a mode flag sprinkled
      through controllers is a rule that usually holds.

- [x] **10.4 Limits that mean the machine, not the tenant.** Shipped
      2026-09-03 — see §2.35.
      `MAX_PROJECTS_PER_USER` (20), `USER_DISK_QUOTA_MB` (2048),
      `PROJECT_DISK_QUOTA_MB` (512), `MAX_CONTAINERS_PER_USER` (2) and
      `MAX_CONCURRENT_CONTAINERS` (3) are rationing between tenants. At n=1 the
      only real limit is the host, and a 512 MB disk quota on your own machine
      is an editor refusing to save into free space.

      §6 decision 15 already draws exactly the line this needs — what the
      platform *allocates* versus what the host *has* — and §2.22 moved the
      first group into a `Plan` row. So this is a plan, not a rewrite: a
      "personal" plan whose allocations are unbounded, with
      `CONTAINER_MEMORY_MB` and `MAX_CONCURRENT_CONTAINERS` still honest about
      the machine, per decision 15.

      **§6 decision 3 is in the same bucket and should be re-read here.**
      Refusing a language server below 1024 MB of container memory, and shipping
      LSP behind a default-off flag because "the image cost is paid by every
      cold start", is multi-tenant economics. One person who wants Python
      intelligence wants it on.

- [x] **10.5 Say which of the platform has no second person, and let it be
      turned off.** Shipped 2026-09-03 — see §2.36. Recorded as one row because it is one decision taken
      thirteen times, and because leaving it implicit is how a personal
      deployment ends up shipping a report queue.

      No user at n=1: presence, follow mode, the collaborative document layer,
      share links, embeds, the public gallery and Explore, report-and-review and
      the whole moderation path (§6 decisions 11, 12, 13, 18), the operator
      console, API keys, teams, plans, entitlements, warning-before-the-wall,
      and billing. That is most of §8 and a good share of §2.

      Still wanted at n=1, and worth naming so they are not swept up: deploy and
      custom domains (personal projects still get published), scheduled jobs,
      notifications, the assistant, the database panel, GitHub, checkpoints,
      trash.

      **And one row on this page becomes more important rather than less.**
      §3.3's backup-and-restore is filed as blocked on a deployment decision
      about where backups go. At n=1 there is no operations team behind it and
      the host is somebody's laptop, so "this platform loses data when its host
      does" stops being an acceptable written trade-off. §9.1 shipped the trash;
      the backup half is still open and it moves up.

---

### Blocked on 10.1 — parity, and free under Route A

Each row says what it costs on Route B, because that is the number the route
decision needs. Under Route A the cost of every one of them is zero.

- [ ] **10.6 Debugging.** No breakpoints, no stepping, no watch, no call stack,
      no `launch.json` — `grep` for `launch.json` or `DAP` over `apps/` returns
      nothing. Route B means a hand-written Debug Adapter Protocol client, a
      breakpoint gutter and decoration layer, a variables/watch/call-stack UI, a
      per-language adapter shipped into each sandbox image, and a stdio bridge
      through `docker exec` — every piece of which §6 decision 2's argument
      against `monaco-languageclient` applies to twice over. This is the single
      largest item in this section and the one Route A most obviously wins.

- [ ] **10.7 Extensions.** **Unreachable on Route B.** Not "expensive" —
      decision 1's closing sentence is that Monaco cannot reach it at all, and
      §3.3 already lists "the user's own VS Code extensions" as out of scope for
      that reason. Worth stating as a row anyway, because a personal IDE is
      largely defined by the six extensions its owner cannot work without, and
      "we have a file-icon table" is not an answer to that.

- [ ] **10.8 Languages past Python and Go.** `lspPolicy.ts` knows two servers:
      `pylsp` and `gopls`. TypeScript and JavaScript get Monaco's bundled
      worker, which is per-model and does not see the project the way `tsserver`
      does; everything else — Rust, Java, C/C++, C#, Ruby, PHP — gets syntax
      highlighting and nothing. The sandbox images are the other half of it:
      `images/` has node, python, go and egress, so a Rust server has no
      container to run in.

      Route B cost: one policy entry and one image per language, plus whatever
      each server needs that the gateway does not yet speak (`lspClient.ts` is
      the seam decision 2 named, and decision 2's revisit trigger — "the
      language surface growing past diagnostics, completion and hover" — is
      reached the moment somebody wants rename or code actions).

- [ ] **10.9 Settings, keybindings and snippets that live in files.**
      `editorSettingsStore` persists sixteen preferences to `localStorage` under
      `rc-editor-settings`, and `keybindingStore` holds chord overrides the same
      way. That means: no `settings.json`, no per-workspace settings, nothing
      diffable, nothing committable, nothing that survives clearing site data,
      and no way to bring an existing VS Code profile across. Snippets do not
      exist at all.

      This is the row that most decides whether the thing *feels* like a
      personal editor, and it is the cheapest of the nine on Route B.

- [ ] **10.10 Tasks.** A project carries exactly one run command (§2.7 row 7,
      read from `package.json` at import) plus a test command (§2.18). VS Code
      has `tasks.json`: named tasks, build versus test groups, compound and
      dependent tasks, and problem matchers that turn compiler output into
      entries in the problems panel. The problems panel already exists
      (`problems.ts`, `ProblemsPanel`) and is fed only by the language server,
      so the matcher half has somewhere to go.

- [ ] **10.11 A real diff editor.** `parseUnifiedDiff` plus `DiffView` renders
      `git diff` output; `grep` for `createDiffEditor` returns nothing, so
      Monaco's own side-by-side diff is unused. What is missing is the thing you
      reach for daily and not the thing you reach for at commit time: compare
      with saved, compare two arbitrary files, compare against a branch, and
      **edit inside the diff**.

- [ ] **10.12 Local history, and a timeline.** No timeline view and no per-file
      history. Checkpoints (§2.x) are the nearest thing and they are the wrong
      granularity — whole-project, explicit, and on the same disk as the tree
      they snapshot. VS Code's local history is per file, automatic, and answers
      "what did this look like an hour ago" for a file that was never committed,
      which is the question checkpoints do not answer.

- [ ] **10.13 The rest of git.** `gitService.ts` covers status, diff, stage and
      unstage, hunk staging, commit, log, branches, switch, discard, remotes,
      fetch, pull, push and conflict resolution — a genuinely complete daily
      loop. Absent: stash, blame, amend, revert, tags, cherry-pick, rebase
      (including interactive), a commit graph, and comparing two branches.
      Stash and blame are the two a personal user notices in the first week.

- [ ] **10.14 The small ones, listed so they are not each rediscovered.**
      Multi-root workspaces (one project is one root, and there is no
      `.code-workspace`); markdown preview; notebooks; terminal profiles
      (`shellArgv` hardcodes `/bin/bash`) and split terminal panes (multiple
      terminals exist, as tabs only); and editor split views beyond the single
      Monaco instance.

---

### Order

**10.1 first, and nothing from 10.6–10.14 before it.** That is the whole point
of the section: nine rows of hand-built parity are the wrong answer if the
answer is openvscode-server, and there is no way to find out by building one of
them.

Then, whichever way 10.1 goes:

~~**10.2 → 10.3 → 10.4 → 10.5.**~~ **All four shipped 2026-09-03** — §2.33
to §2.36. What is left in this section is 10.1 and the ten rows behind it. ~~Open-a-folder first~~ — done 2026-09-03
(§2.33), and the reasoning below held: the mount was an afternoon and finding
every place that assumes this server made the tree was the rest of it. **Next
is 10.3.** Original note follows.

Open-a-folder first because it is the one
without which none of the rest is a personal IDE — you cannot use an editor on
work you cannot open in it — and because it is the largest, in the way §9.1 was
largest: the assumption that this server created the tree is spread across
quota, checkpoints, delete and confinement, and finding all of it is most of the
work. Single-user mode second because everything after it is easier to test
without an auth ladder in front of it. Then the limits, then the switch-off
list, which is a decision-per-line and reads fastest once the first three have
made obvious which lines matter.

If 10.1 goes to **Route A**, 10.6–10.14 close as one migration and this section
becomes short. If it goes to **Route B**, take them 10.9 → 10.13 → 10.11 →
10.10 → 10.12 → 10.8 → 10.14 → 10.6, and strike 10.7 as unreachable: settings
files and stash/blame are days, debugging is months, and 10.7 is never.

**A caution in the spirit of §4.** This section was written by reading the
parity ledger against the code and against §6, which is the method §4 says finds
roughly twice the work that gets written down. It has not been validated by
anybody trying to use this as their daily editor for a week, and that week would
almost certainly reorder these rows — most likely by promoting something in
10.14 that reads trivial here and is intolerable in practice.

---

## 11. The word "cloud" is doing no work yet

Written 2026-09-05. §10 asked what stops one person using this instead of VS
Code, answered it as a question about **editor parity**, and reached an
architectural route decision (§10.1). This section is what turns up from
reading the other half — the **sandbox and the server**, not Monaco — and none
of it is in §10, because §10 was written against the parity ledger and §6 and
never opened `devcontainer.ts`'s refusal list, the idle reaper, or
`apps/server/src/index.ts` line 83.

Everything below was checked against the source; the list is at the end,
under "What was verified for this section".

The theme, and it is one theme rather than seven: **§10.4 made an argument and
then applied it in exactly one place.** Its argument is that
`MAX_PROJECTS_PER_USER`, `USER_DISK_QUOTA_MB` and the rest are *rationing
between tenants*, and that at n=1 there is nobody to ration against — so they
became a `personal` plan rather than a rewrite. That argument is correct and it
is not finished. The same sentence is true, word for word, of the sandbox's
**capabilities**, of its **lifecycle policies**, and of the assumption that the
person at the keyboard is sitting at the machine. §10.4 found the limits
because they had numbers in a config file and were easy to see. The rest of the
multi-tenant posture is spread through refusal strings, a 60-second interval
and a default origin, and it is the same decision every time.

---

### 11.0 §10.1 is a false binary

§10 is emphatic that ten of its rows are blocked on one choice — Monaco
(Route B) or openvscode-server (Route A) — and that building any of them while
undecided is waste. That is right about the two routes it names. It is a
two-item list of a three-item set.

**Route C — make the workspace attachable, and let the user bring the
editor.** `grep -ri "sshd\|ssh-agent\|SSH_AUTH_SOCK" apps/` returns nothing:
there is no way to reach a project's container except through this app.
Give it one — an sshd in the sandbox image, a key the account owns, and a way
in from outside — and the user's own VS Code, Cursor, Zed, IntelliJ or `nvim`
attaches to the workspace directly.

What that does to §10's blocked list is the point:

| §10 row | Under Route C |
|---|---|
| 10.6 Debugging | **arrives complete.** The client is a real editor; the DAP client, breakpoint gutter, watch UI and per-language adapters are all its problem, not this repository's |
| 10.7 Extensions — *"unreachable on Route B"* | **arrives complete,** and it is the user's actual extensions with their actual settings, which is more than Route A offers |
| 10.8 Languages past Python and Go | mostly arrives; the sandbox image still needs the toolchain, but not `lspPolicy.ts` and not the gateway |
| 10.9 Settings, keybindings, snippets | theirs already, on their machine |
| 10.11 Diff editor, 10.13 the rest of git | theirs already |

That is the two most expensive rows in §10 and three of the cheap ones, for one
image change and a key store.

**It is not free and it is not a substitute — be honest about both.** Route C
concedes that the browser editor is not where the serious work happens, which
is a strategic concession and not a technical one, and somebody has to be
willing to make it. It does nothing on an iPad, where there is no local editor
to attach — and the iPad is a large part of why anybody wants a cloud editor at
all. It puts an sshd in a sandbox whose whole security posture is `CapDrop:
["ALL"]` and `no-new-privileges`, so the key handling has to be right the first
time. And it leaves 10.10, 10.12 and 10.14 exactly where they were.

**What it changes is the stakes of §10.1, and that is worth more than the
feature.** §10 argues Route B is defensible only if multiplayer is the point,
because Route B can never reach 10.7. If 10.7 arrives over SSH, that sentence
stops being true: **staying on Monaco stops costing you extensions and
debugging**, and the browser editor is then free to be what it is already good
at — the thing you open on a machine you do not control, to fix one file. Route
A and Route C are also not exclusive; Codespaces ships both, which is the
existence proof that the two-item framing was the accident and not the answer.

- [ ] **11.1 Put Route C in front of the §10.1 decision before it is taken.**
      Not a build — a paragraph in §10.1 and a re-read of its table. Doing it
      afterwards is how a route gets chosen against a cost that was never the
      real one.

---

### The sandbox refuses things for reasons that expire at n=1

`devcontainer.ts` reports every key it will not honour, each with a reason
written for the user (`UNSUPPORTED_REASON`, lines 88–110). The list is
`dockerComposeFile`, `service`, `runServices`, `features`, `mounts`, `runArgs`,
`privileged`, `capAdd`, `securityOpt`, `initializeCommand`.

Read them as a group and they are one posture, correctly held: **this is a
sandbox running a stranger's code, so the platform decides what the container
is and the repository does not.** Every one of those refusals is right for §8's
product.

At n=1 the stranger is you, on your own machine, and they stop being one
decision. Three groups:

**Still right, and should stay refused however personal this gets.**
`privileged`, `capAdd`, `securityOpt`, `runArgs`. Not because of the tenant —
because a container that can do anything to the host is a container that can
destroy the tree it is mounted on, and §6's confinement work exists to make
that impossible by construction rather than by care. `initializeCommand` runs
on the *host*: refuse it forever.

**Wrong at n=1.** `features` — "install what you need in postCreateCommand
instead" is a fair answer to a tenant and a poor one to yourself, because Dev
Container Features are how the ecosystem distributes "add the AWS CLI" and
rewriting each one by hand is exactly the work the format exists to delete.
`mounts` — "the project directory is the only thing mounted, deliberately" is
a confinement rule about *other people's* directories; your own `~/.aws` is not
that, and 10.2 already shipped the machinery for a root this server did not
create.

~~and cheap~~ — **half of that was wrong, and building it is what showed
which half.** See 11.2 and 11.10.

- [x] **11.2 Re-decide the refusal list for the personal plan, one line at a
      time.** Shipped 2026-09-05 **for `mounts`**; `features` came out as its
      own row, 11.10, because it is not the same size at all.
      As a plan entitlement, per §10.4's precedent, and **not** as a
      mode flag read in `devcontainer.ts` — §6 decision 13's argument applies
      unchanged. The output is a shorter `UNSUPPORTED_REASON` under the
      `personal` plan and the same one under every other.

      The mechanism came out as decision 13 asks: `interpret` takes a
      `DevcontainerCapabilities`, the caller resolves the entitlement once and
      hands the answer down, and **the default is nothing granted** — so a call
      site that forgets gets the behaviour that existed before this row.

      **What this row did not anticipate is that `mounts` needs two gates, not
      one.** Every other limit on the plan table rations something the USER
      asked for. A mount is asked for by a file inside the repository, which
      may have been cloned from a stranger five minutes ago — so a plan flag
      alone would mean that opening somebody else's project mounted whatever
      that project named, and `/var/run/docker.sock` is a path like any other.
      So: `devcontainerMounts` on the plan says whether an account may ask, and
      `DEVCONTAINER_MOUNT_ROOTS` — empty by default, where empty means refuse —
      says what there is to ask for. The confinement itself is
      `resolveLocalFolder`'s, reasoning and all: shape, then `realpath`, then
      the allowlist against the RESOLVED path, then the server's own trees
      refused even inside a named root.

      A refused mount is collected rather than thrown, and shown next to the
      unsupported keys as a *separate* block — an unsupported key was never
      read, a refused mount was, and only the second can be fixed by changing a
      setting rather than the file.

      Writing the tests found a real bug in the first version: the
      target-inside-the-workspace check used `path.sep`, which is `\` on a
      Windows host, so a mount over `/home/sandbox/app/data` was accepted
      there and refused everywhere else. Host separators and container
      separators are not the same character, and one `within` helper reading
      like one rule was hiding two.

**And one that is not a line on that list but the largest single gap in this
document.**

- [ ] **11.3 Compose — more than one container per project.**
      `dockerComposeFile`, `service` and `runServices` all refuse with the same
      sentence: *"This platform runs one container per project."* That is an
      architecture statement, not a policy, and it is why this row is separate
      from 11.2 and cannot be granted by an entitlement.

      It matters more than its position in the format suggests. A very large
      share of real repositories are not "an app" — they are an app, a
      Postgres, a Redis and sometimes a worker, wired together in
      `docker-compose.yml`, and `docker compose up` is the documented way to
      start them. Today such a repository opens in this editor, shows a
      `docker-compose.yml` with a Docker icon (`fileTypes.ts:209`), and cannot
      be run at all. The database panel does not close this: it gives a project
      *a* Postgres this platform manages (§6 decision 4 pairs it with the
      container's lifecycle), which is a different thing from the four services
      the repository's own file describes.

      **Check the shape before starting, because three subsystems assume the
      singular.** `containerName(projectId)` is one name per project;
      `getPreviewTarget` and `publishedPorts` resolve ports against one
      container; the idle reaper and `stopAllContainers` enumerate by a single
      prefix. The honest first version is probably not general compose support
      but **"the project's container, plus the services it declares, as one
      lifecycle unit"** — which is precisely the relationship §6 decision 4
      already built and argued for the database container, generalised from one
      sidecar to several.

---

- [ ] **11.10 Dev Container Features.** Split out of 11.2 on 2026-09-05,
      because calling it "cheap" there was wrong and only became obvious with
      `mounts` finished beside it.

      A Feature is not a setting to honour. It is an OCI artifact — a
      `devcontainer-feature.json` and an `install.sh` — so supporting them
      means a registry client, manifest and layer fetching, tarball
      extraction, an options-to-environment mapping, and `installsAfter`
      ordering between them. None of that is the hard part.

      **The hard part is that install scripts assume root, and this sandbox
      does not have one.** Containers here run as a uid matched to the bind
      mount's owner, with `CapDrop: ["ALL"]` and `no-new-privileges` — see
      §6's confinement work and 11.2's "still right, and should stay refused"
      list, which keeps `privileged` and `capAdd` refused *however personal
      this gets*, because a container that can do anything to the host can
      destroy the tree it is mounted on. A Feature that runs `apt-get install`
      needs exactly what that list refuses.

      So this is not one row of work, it is a question with three answers, and
      picking one is what unblocks it: run Features at BUILD time into a
      derived image (which means this platform builds images, which `build`
      and `dockerFile` are currently refused for); run them as root in a
      throwaway container and commit the result; or support only the subset
      that installs into the user's own home directory, which is a minority of
      real Features and would refuse the rest confusingly rather than clearly.

      Until one is chosen, `postCreateCommand` remains the honest answer and
      the refusal string is correct.

### The lifecycle policies also assume somebody else wants the memory

- [x] **11.4 Stop reaping a container nobody is watching.** Shipped
      2026-09-05.
      `startIdleReaper` stops any project container with no active attachments
      after `CONTAINER_IDLE_MINUTES` (default 20), and §6 decision 4 correctly
      takes the project's database down with it. Between tenants that is right:
      an idle container is somebody else's RAM.

      At n=1 it is the editor deciding that closing a tab means killing your
      dev server, your watch process, your long import and your `tmux`-shaped
      intentions — and the reaper cannot tell "I am done" from "I closed the
      lid". §10.4 moved the *limits* to a plan and did not touch this, because
      it is not a limit; it is a policy with the same multi-tenant premise. The
      `personal` plan wants it off, or wants it long enough to be about the host
      running out of memory rather than about sharing.

      **This row named the wrong interaction, and building it found the right
      one.** It said that with the reaper off, `reconcileOnBoot` would have to
      bring a project's containers back or a host reboot would silently end
      every long-running process. That is not a consequence of this change: a
      reboot ends the processes either way, and restarting the container does
      not restart what was running inside it. Resuming a process across a
      restart is §3.3's process-snapshots row, which is blocked on a mechanism
      nothing here resembles, and it stayed exactly where it was.

      The real interaction is the opposite one, and it is load-bearing rather
      than a note. **The reaper is what frees slots against
      `MAX_CONCURRENT_CONTAINERS`.** Turn it off and nothing ever gives a slot
      back, so the third project a user opened would be the last one they could
      open until they restarted the server. Shipping the plan half alone would
      not have given anybody a long-lived container; it would have traded "your
      dev server was killed" for "you cannot open a fourth project", which is
      not an improvement.

      So it shipped as two halves. `idleMinutes` on the plan (0 = never, the
      `UNLIMITED` sentinel), read per project by the reaper from the owner's
      entitlements and falling back to `CONTAINER_IDLE_MINUTES` on any failure —
      because a reaper that stopped reclaiming during a database blip would
      turn that blip into the memory exhaustion it exists to prevent. And
      `reclaimForCapacity`, which on a full machine stops the least recently
      used container nobody is attached to rather than refusing. Attachments
      are never overridden: when everything is being watched it still refuses,
      because taking one person's running work to give another a slot is worse
      than an honest 503.

      That is decision 15's line landing exactly where it should. **The plan
      decides whether idleness alone is a reason to stop something; the host
      still decides when it is out of room.** The plan card says "Never sleeps"
      rather than "runs forever" for the same reason.

---

### Reaching it from a machine that is not the host

This is where the section's title comes from. **Nothing in this platform is
reachable from anywhere except the computer it runs on**, and a personal
*cloud* IDE whose premise is "my machine is not where I am" has not delivered
its premise.

`index.ts:83` is `createServer(app)` from `node:http` — no TLS anywhere in the
process. `WEB_ORIGIN` defaults to `http://localhost:5273`. There is no
`Caddyfile`, no `nginx.conf`, no tunnel client, and nothing in `docs/` that
says how you are supposed to get to it.

**§3.3's certificate row is not this row, and it would be easy to file this
there and lose it.** That row is about ACME certificates for *user-deployed
custom domains* — the third origin, the published sites. This is about reaching
**the editor itself**, which needs one hostname and one certificate and none of
the per-domain challenge machinery §9.2 split out.

- [ ] **11.5 A documented way in from outside, and the smallest one that is
      honest.** A reverse proxy terminating TLS in front of the API and web
      origins, one name, and a written answer for how it is obtained — Caddy
      with a DNS challenge, or a tunnel (Tailscale, Cloudflare) that sidesteps
      certificates and inbound ports entirely and is very likely the right
      answer for a laptop behind NAT. What makes this a row rather than a
      README is that the *app* has opinions about it: `COOKIE_SECURE`,
      `COOKIE_SAME_SITE` and `WEB_ORIGIN` all change meaning once there is a
      real origin, and the preview origin and the deployment origin have to
      come along or half the product 404s.

- [ ] **11.6 Re-read the auth surface for an editor on the open internet.**
      §10.3's single-user mode was designed for a laptop and is honest about it,
      and it got the central thing right — *"a server that issued one to anybody
      who asked would be an unauthenticated server on whatever network it is
      reachable from"*, so sign-in stays even at n=1. 11.5 is what makes that
      sentence load-bearing rather than cautious.

      What it does not have: **`grep -ril "totp\|twoFactor\|mfa" apps/server/src`
      returns nothing.** One password, rate-limited (`auth.ts` has
      `addressLimiter` and `refreshLimiter`, which is more than most), standing
      between the internet and a shell on your machine with your source tree
      mounted. On a laptop that is proportionate. Exposed, the threat model is
      not "somebody reads my code", it is `docker exec`, and this deserves
      re-deciding rather than inheriting.

- [ ] **11.7 The laptop lid.** No service worker, no manifest —
      `apps/web/public` is `favicon.svg` and `vite.svg`. A cloud editor is used
      on trains and on hotel wifi, and today a dropped connection is a blank
      page rather than a degraded one. Not offline editing, which is a CRDT
      argument this document does not need: an installable shell, a legible
      "you are offline" state, and not losing the buffer.

      The layout half is further along than expected and should not be
      re-derived: `index.css` already turns the side and bottom panes into
      overlay drawers below 900px, drops the drag dividers, and has a scrim
      (lines 1194–1235). What is untested is Monaco itself under a touch
      keyboard, which is the part that decides whether the iPad case is real.

---

### The two small ones, so they are not each rediscovered

- [x] **11.8 Search that knows about more than one project.** Shipped
      2026-09-05.
      `searchService.ts` exports exactly one entry point, `searchProject(projectId, …)`,
      and the worker is handed `root: projectRoot(projectId)`. Every search in
      this product is inside one project. With thirteen templates and a
      personal machine's worth of repositories, "which project did I write that
      in" has no answer, and it is the question you ask most often about code
      you wrote yourself. Cheap: the worker already takes a root.

      It was cheap, and "cheap" hid three decisions worth writing down.

      **Scope is owned, not accessible.** A global search box that reached into
      projects shared WITH you would quietly widen how far one keystroke sees:
      a collaborator invited to one file's worth of work would find their whole
      repository in somebody else's sidebar. Reaching a shared project is what
      opening it is for, and that path checks access per project.

      **A partial answer has to say so.** Twenty-five projects, four at a time,
      fifteen seconds, and whatever is done when that expires. A search that
      stopped early and did not admit it makes a missing result read as proof
      the text is nowhere — which is worse than a slow answer and much worse
      than no feature. One project failing is skipped rather than raised, for
      the same reason: §5 has found two rows with no working tree, and either
      would otherwise have broken every cross-project search as "not found".

      **The project is the answer, so the result has to leave the project.**
      Grouped by project rather than by file — "src/index.ts" is in most of
      somebody's projects — and clicking a result requests the reveal, then
      navigates. The tab store outlives the route and the socket does not,
      which is why `ProjectPlayground` now opens whatever a pending reveal
      names once it has a socket. Without that the search finds the right
      project and drops you at its front door, which is most of the way to
      useless.

      A REST route rather than the editor socket, because the socket is bound
      to one project and is the whole reason this gap existed. Mounted at
      `/api/v1/search` with no id in the path — the same scoping `/account`
      and `/notifications` already use, which is the only kind nobody can
      forget to apply.

- [ ] **11.9 An identity that follows you into the container.**
      Two halves. **Dotfiles — shipped 2026-09-05.** Three settings on the
      account, deliberately the same three VS Code exposes, cloned into every
      container on creation and applied before the devcontainer's own
      lifecycle commands: a `postCreateCommand` may reasonably assume the
      shell it was typed for. Best-effort like that lifecycle is, and for the
      same reason — this is arbitrary code out of a repository the platform
      does not control, so a broken one leaves a working container and a
      readable log rather than a project that will not open.

      Three refusals are the whole of the security argument, and each is a
      different risk. **https only**, because an `ssh://` clone would
      authenticate as the SERVER with whatever key the host happens to have.
      **No credentials in the URL**, because that is a password, and it would
      sit in a column in the clear. **Not `/home/sandbox/app`**, because that
      is the bind mount: dotfiles cloned there land in the user's repository,
      on the host disk, and against their quota, and would be found later as
      an unexplained `dotfiles/` directory in a commit. A private dotfiles
      repository therefore fails rather than working, which is the intended
      answer — the alternative is handing a GitHub token to a clone running
      inside a container full of somebody else's dependencies.

      Two things were found by running it rather than by reading it, which is
      §11's own closing warning holding again. `~/` expanded to
      `/home/sandbox/`, which is not equal to the home directory and does
      start with it, so it walked straight past the refusal of the home
      directory; the trailing slash is now stripped before the comparisons
      instead of after. And the installer detection was a shell function
      called as an `if` condition — where `set -e` is suspended — so an
      `install.sh` that FAILED read as "no installer found" and fell through
      to the symlinking fallback as though nothing were wrong. It is an
      if/elif chain now. Both were caught by tests; the whole script was then
      run in a real container against a real repository, which is what proved
      the linker skips `.git`, refuses to clobber a real `~/.bashrc`, and is
      safe to re-run — it runs on every container creation, not once.

      **Commit signing** — still absent. `grep` for `gpgsign`, `ssh-agent` and
      `SSH_AUTH_SOCK` over `apps/server/src` returns nothing, so commits made
      here structurally cannot be signed. The table this half will use exists
      already: the `user_personalization` migration carries `signingKey`,
      `signingKeyPublic` and `signCommits`, unused, so that the two halves are
      one schema change rather than two. If 11.1's Route C ships an agent
      socket, this comes most of the way with it, which is the only dependency
      between any two rows in this section.

---

### What was verified for this section

Checked against the tree on 2026-09-05, in the manner §5 requires:

- `apps/server/src/index.ts:83` — `createServer(app)`, `node:http`. No TLS.
- `devcontainer.ts:88–110` — the ten refusals quoted are the actual strings.
- `containerManager.ts:842–885` — the reaper's condition is
  `activeAttachments === 0` and `CONTAINER_IDLE_MINUTES`, default 20
  (`env.ts:408`), and it calls `onProjectReaped` for the database pair.
- `searchService.ts:120` — `searchProject` is the only exported search.
- `grep -ril "totp|twoFactor|mfa"` over `apps/server/src` — no hits.
- `grep -rn "gpgsign|SSH_AUTH_SOCK|ssh-agent"` over `apps/server/src` — no hits.
  Still none as of 2026-09-05: 11.9's dotfiles half shipped and its signing
  half did not, so this line is unchanged rather than stale.
- `apps/web/public` — two SVGs, no manifest, no service worker.
- `index.css:1194` — the ≤900px drawer layout exists, contrary to what a
  section about mobile would otherwise have assumed.
- `apps/server/templates` — 13, as §10 says.

**Not verified, and load-bearing for 11.1:** nobody has put an sshd in a
sandbox image and attached a real editor to it. The claim that 10.6 and 10.7
"arrive complete" is how Remote-SSH works elsewhere, not something this
repository has demonstrated. It is a day's spike and it should be run **before**
11.1's paragraph is written into §10.1, because the whole argument rests on it.

**A caution, in the spirit of §4 and of §10's own closing note.** §10 warned
that it had not been validated by anybody using this as their daily editor for
a week. This section is the same method applied to the platform instead of the
editor, so it carries the same warning and one more: it was written the day
after three defects were found in the container layer that no test and no
section of this document predicted — an orphaned shell holding a port
(`ee09897`), a pid file that could be overwritten, and `sleep infinity` as pid 1
reaping nothing (`3e269e0`). All three had been there for the life of the
project, all three were found by looking at a running container rather than at
the code, and none is the kind of thing that appears on a roadmap. **The most
likely error in this section is not a wrong row; it is that the container layer
holds more of these, and they are found by running the thing rather than by
writing about it.**

---

## 12. What a cloud machine is for

Written 2026-09-05, the same day as §11 and out of the same reading. §11 asked
what the *sandbox* assumes that stops being true at n=1 and found seven things.
This section is what is left after that: **four capabilities that are not
multi-tenant posture at all, and are simply absent.** They did not appear in
§10 because §10 was written against the parity ledger — it asks what VS Code
does that Monaco cannot — and none of these is an editor feature. They did not
appear in §11 because §11 reads refusals and policies, and an absence has no
refusal string to find.

The organising question is narrower than §10's and §11's, and it is the one a
person actually asks when deciding to keep a workspace on a server instead of
on the laptop in front of them: **what can this machine do that the laptop
cannot?** Everything below is an answer to that and nothing below is an answer
to anything else. That is also the honest ceiling on this section — none of it
makes the editor better, and somebody who wants a better editor should read
§10, or §11.0, which argues the cheapest route to most of §10.

**One correction, recorded because this section exists to be read later.** An
earlier reading of the tree said container CPU and memory were deployment-wide
constants with no notion of a personal deployment. That was wrong: `env.ts:382`
and `env.ts:430` already read `unshared ? 2048 : 512` and `unshared ? 2 : 0.5`,
which is §10.5's sole-tenant flag doing exactly what §10.4 said it should. The
gap is real but a size smaller than first stated, and 12.1 is written against
what is actually there.

---

- [x] **12.1 A workspace that is not the same size as every other
      workspace.** Shipped 2026-09-05 — see §2.38. Original note follows.

      The strongest row here, and the only one that is about the *reason* to
      use a server at all.

      `containerManager.ts:593–597` sizes every project container from
      `env.CONTAINER_MEMORY_MB` and `env.CONTAINER_CPUS`. §10.5's `unshared`
      flag already raises those to 2048 MB and 2 CPUs on a personal deployment,
      so the multi-tenant default is not the problem. **The problem is that
      there is one number.** Every workspace on the host is the same size, and
      the thing a cloud machine is *for* — the Rust workspace that wants 8 GB
      while eleven others idle at 512 MB — cannot be expressed.

      **Read §6 decision 15 carefully before building this, because it is
      nearly but not quite in the way.** Decision 15 says a plan may promise
      more of what the platform allocates and must never promise more of what
      the host has: a "Pro" tier claiming more memory per container than the
      machine can give is a promise kept by an OOM kill in somebody's terminal.
      That forbids *selling* a size. It does not forbid a workspace differing
      from its neighbour, and the two have been treated as one question because
      only the first was ever asked. The personal case has no tenant to
      over-promise to; the constraint is arithmetic against one host, which is
      a sum this server can actually do.

      Which suggests the shape: a per-project size, defaulting to today's
      constant, refused at the point of setting it if the sum of the sizes of
      what is *currently running* would exceed what the host has — not a plan
      entitlement, and not a promise made in advance. `MAX_CONCURRENT_CONTAINERS`
      is the existing crude version of that sum and would become redundant.

      **Second call site, and it is the one that would be missed.**
      `containerManager.ts:1187` computes `memoryLimitBytes` for the stats
      panel from the same global constant. A per-workspace size that did not
      reach it would show every project a ceiling that is not its own, which is
      worse than showing none — §2.22's argument about a limit that appears on
      no pricing page, in a different costume.

- [x] **12.2 Build before somebody is waiting.** Shipped 2026-09-05 — see
      §2.39, which took the running-workspace half and split the rest out as
      12.5. Original note follows.

      `warmStart.ts` exists and
      skips the redundant install on a container that already has one, which is
      the half of this that was worth doing first. What does not exist is
      anything that builds **ahead of** a session: the first open of a
      workspace after a dependency change pays the full cost with a person
      watching it.

      The mechanism is mostly present rather than mostly absent, which is what
      makes this cheap: there is a scheduler (§2.13), a run reconciler, and a
      warm-start path that already knows what "already installed" means. What
      is missing is a trigger and a policy — build on push, or build on a
      schedule, or build when a `devcontainer.json` changes — and a decision
      about what happens when a prebuild fails, which should be *nothing
      visible*: a prebuild that announces its own failure to somebody who was
      not waiting for it has converted a saved minute into an interruption.

      **Not to be confused with §3.3's process snapshots**, which is a
      different and genuinely blocked thing. A prebuild produces a warm
      *image*; a snapshot resumes a running *process*. This row needs no new
      mechanism and that one needs a mechanism nothing here resembles.

- [ ] **12.5 Start a stopped workspace to build it.** Split out of 12.2 on
      2026-09-05, the way 11.10 was split out of 11.2 — and for the same
      reason: building it revealed which half was a line of code and which was
      a decision nobody has taken.

      12.2 prebuilds workspaces that are **already running**, which covers the
      case it was written for (a `git pull` that adds a dependency while you
      have the project open) and not the one its own title describes. The first
      open of a workspace that has been stopped all week still pays the full
      install with somebody watching.

      **Three things collide here and none of them is code.** Starting a
      container to build it spends memory the capacity gate is rationing, on
      work nobody asked for, at a moment the host may want that memory for a
      workspace somebody is actually opening. It fights the idle reaper, which
      exists to stop exactly this. And on the personal plan, whose workspaces
      never sleep (§11.4), nothing would stop it again afterwards — so a
      prebuild would silently convert a stopped workspace into a running one,
      which is a change to what the machine costs rather than to how fast it
      opens.

      The shape of an answer is probably: only when the host is below some
      fraction of its budget, only for workspaces opened recently enough to be
      likely to be opened again, and stop it afterwards unless the plan says
      otherwise. All three of those are numbers somebody has to choose, and
      choosing them without having watched a real host is how a background task
      becomes the reason a machine is always busy.

- [ ] **12.3 Notebooks.** Zero occurrences of `notebook` or `ipynb` anywhere in
      `apps/` or `packages/`. It appears twice in this document, both times
      inside a parenthetical list of things VS Code has, and has never been a
      row.

      Listed here rather than in §10 because it is not editor parity in the
      sense §10 means: a notebook is a document format with an execution model
      attached, and the execution model is a kernel process in the container —
      which is this section's subject and not Monaco's. **Worth doing only if
      you write Python**, and worth saying so plainly rather than carrying it
      as a neutral gap: for somebody who does not, it is a large feature with
      no user, and this file has enough of those.

      The honest note is that the sandbox already runs Python and already has
      an LSP for it (§6 decision 3), so the distance is a kernel protocol and a
      renderer, not a language.

- [ ] **12.4 A machine with hardware the laptop does not have.** Zero hits for
      `gpu`, `nvidia`, `cuda` or `DeviceRequests`. Dockerode supports device
      requests; nothing here passes any.

      Ranked last deliberately, and kept because it is the *purest* form of
      this section's question — it is the one thing on this page a laptop
      cannot answer by being a better laptop. It is also the row most likely to
      be somebody else's product: renting a GPU is a market with incumbents,
      and a personal IDE that grew one would be competing on the hardware
      rather than on the editor.

      **Blocked on hardware, not on a decision**, which puts it in §3.3's class
      rather than this one's — and it is here rather than there only because
      §3.3 is about this platform's gaps and this is about a machine's. If the
      host has no GPU the row is unstartable, and if it has one the work is a
      `DeviceRequests` entry and a plan flag, which is an afternoon.

---

### The pattern these four share, and what it predicts

None of these was found by reading the code. §11's seven came out of
`devcontainer.ts`'s refusal list, the reaper's condition and `index.ts:83` —
all of them things the tree says out loud. **These four came out of asking what
is not there**, which is a question no grep answers and no test fails.

That is worth recording because it is the third distinct method this document
has used, and the three find different things:

| Method | Finds | Sections |
|---|---|---|
| Reading two shipped features against each other | defects | §2.16, §2.20, §2.21 |
| Reading a policy and asking who it is for | posture that expired | §10.4, §11 |
| Asking what a category has that this does not | absences | §12 |

The third is the weakest of the three and should be trusted least: it produces
long lists cheaply, most of an ecosystem's features are not wanted by any
particular person, and the only defence is the one applied above — say who each
row is for, and say plainly when the answer is "possibly nobody here". Two of
these four rows carry that caveat in their own text.

### What was verified for this section

Checked against the tree on 2026-09-05, in the manner §5 requires:

- `containerManager.ts:593`, `:596`, `:597` — `Memory`, `MemorySwap` and
  `NanoCpus` all read the global `env` values; no per-project term.
- `containerManager.ts:1187` — `const limit = env.CONTAINER_MEMORY_MB * 1024 *
  1024`, the second call site named in 12.1.
- `env.ts:378–382` and `:427–430` — `CONTAINER_MEMORY_MB` defaults to
  `unshared ? 2048 : 512` and `CONTAINER_CPUS` to `unshared ? 2 : 0.5`;
  `unshared` is `inDevelopment || soleTenant` (`env.ts:46`). This is the fact
  that corrected 12.1 downward.
- `grep -rniE "\bgpu\b|nvidia|DeviceRequests|cuda"` over `apps/server/src` and
  `packages/shared/src` — **0 hits.**
- `grep -rniE "notebook|ipynb"` over `apps/server/src`, `apps/web/src` and
  `packages/shared/src` — **0 hits.**
- `apps/server/src/containers/warmStart.ts` exists, with tests; nothing in it
  is triggered by anything but a session starting.

**Not verified, and it is the load-bearing one for 12.1:** nobody has run two
containers of different sizes on this host and watched the sum. The arithmetic
argument against decision 15 is a paragraph, not an experiment, and the failure
mode it is reasoning about — an OOM kill in somebody's terminal — is precisely
the kind §1 says a mock cannot be trusted about.
