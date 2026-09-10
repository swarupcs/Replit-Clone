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

**Looking for what this actually does today rather than how the suite is
doing? §1a.** This section is the health of the tree; that one is the
inventory. **Looking for what to build next? §14**, added 2026-09-09 — it is
the one place that sequences the open rows of §3, §8, §10, §11, §12 and §13
against each other instead of each against its own siblings, and it starts by
saying that this is two products and asking which one is primary. It adds no
rows: every item in it is an existing checkbox, referenced by number, so the
totals below stay the totals.

Verified by running it rather than reading about it. **The numbers are as of
2026-09-05**, and every row below was re-run that day — including the one that
had been carried as "not re-run" since §2.22, which is the row that most needed
it and is dealt with under the table.

| Check | Result |
|---|---|
| `pnpm -r typecheck` | clean, 3/3 packages |
| `pnpm -r lint` | clean, 3/3 packages |
| `pnpm --filter server test` | **2124 passing**, 296 skipped (152 files) — no database configured |
| the same, with `TEST_DATABASE_URL` set | **2938 passing**, 9 skipped. Green 2026-09-09 against all **42** migrations, on a Postgres 16 initialised by hand — see §2.48 and §2.49. The 9 need a Docker daemon, not a database |
| `pnpm --filter web test` | **1410 passing** (116 files), re-run 2026-09-09 |
| Debt scan (`TODO`/`FIXME`/`HACK` over the three `src` trees) | **0** real markers over ~116k lines |

The debt scan returns two hits and neither is debt: both are the literal word
"TODO" inside prose about *searching* for it, in `searchService.ts` and its
test. Recorded rather than filtered, because a scan whose exclusions are not
written down is a scan somebody will quietly widen.

The size figure is the whole of `apps/server/src`, `apps/web/src` and
`packages/shared/src`: 564 files, ~116k lines, of which ~64.6k are not tests.
It was "~51k" here for a long time and that was never re-measured; the growth
is real but the number had also been measuring something narrower.

**The skips are two different things and the two rows exist to keep them
apart.** With no database, 296 tests are skipped: the DB-gated suites plus the
shell-quoting round-trips. With `TEST_DATABASE_URL` set, 36 remain, and those
are only the shell-quoting ones — `/bin/bash` is absent on this Windows host.
Both run in CI.

**The DB-gated row is green again, and that mattered more than usual.** It had
been carried since §2.22 as "not re-run", and eleven migrations have landed
since — §12.1's `workspace_size`, §2.41's `scaffold_recipes`, §11.4's
`plan_idle_minutes`, §11.2's `plan_devcontainer_mounts`, §11.9's
`user_personalization` and §11.6's `two_factor` among them. **Two of those
turned out to be broken**, and neither could have been caught by anything in
this table except this row: they wrote `ALTER TABLE "Project"` where the table
is `projects`, because the model carries `@@map`. Nothing in typecheck, lint
or 2384 tests reads `migration.sql`. Only Postgres does. See §2.41.

The DB-gated row was originally run rather than quoted for §2.11 and §2.12:
both put load-bearing claims in a unique index, a foreign key and a
transaction, and a mock cannot be wrong about those in any way worth trusting.
That argument has only got stronger.

**One test fails on this machine and is expected to.** `localRoots.test.ts`
creates a symlink, and Windows refuses that without Developer Mode or an
elevated shell — `EPERM`. It fails identically on a clean checkout and passes
in CI. It is named here so it is not mistaken for a regression by whoever runs
the suite next.

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

Three flakes are worth knowing about, since each will otherwise be mistaken
for a regression. **All three were seen again on 2026-09-05**, and the first
got materially worse that day for a reason worth writing down: Docker was
building images and running containers while the suites ran, and every one of
these is a timing failure under CPU contention. The suite is not less reliable
than it was; the machine was busier.

- Under load the **web** suite fails at the default 5s timeout, always the
  *first* test in a file and always passing in isolation. On 2026-09-05 this
  reached **15 files failing on a clean checkout** and 8 on a working tree with
  changes in it — which is the right way round to notice that the changes were
  not the cause. Verified as environmental by stashing and re-running.
  `--testTimeout=20000` is green.
- The server suite occasionally dies with `ERR_IPC_CHANNEL_CLOSED` / "Channel
  closed" from tinypool, reporting no test failures at all. Seen three times on
  2026-08-31 and once on 2026-09-05. It is the worker pool, not the tests: the
  next run passes. **Not investigated.**
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

**Done: 174 items. Open: 12 — four blocked, none from §10, whose last row
closed on 2026-09-10 (with two items carried into §2.59), none from §11, whose
last row closed on 2026-09-10, two from §12, which reads neither and
asks what a cloud machine is for, and seven from §13, which names the two
products this most resembles and diffs against them. **§10.1 was decided on
2026-09-09 — B + C — and Route C shipped the same day (§2.50)**, which closed
three §10 rows at once: 10.1 itself, and 10.6 and 10.7 by another road. The
seven that remain are merely open rather than blocked. §11's last row is 11.10, which needs a
decision before it needs code, and 12.4 is blocked on hardware rather than on
anybody.**

Those five numbers are 4 + 0 + 0 + 1 + 7 = 12, and they are written out
because they did not add up once already — see the paragraph below.

**§3.3 lost a row on 2026-09-09 for the third time by being SPLIT rather than
unblocked**, after backups shipped (§2.47) — and the split was the same one
§9 made twice and §2.12 and §2.13 made before that. "Where do backups live"
read as infrastructure and was one question; asked the way §9 asks, the answer
was that this server does not answer it, and what was left was code nobody had
written. Before concluding a row is blocked, check whether it is one thing.

**Two corrections were made to this paragraph on 2026-09-09**, both by §13,
which is the commit that last invalidated it and therefore owns it under §7.
The first is the sum: it read `5 + 10 + 1 + 3 = 19` beside an Open figure of
18, and the arithmetic written out specifically to stop that had itself been
left stale when 12.2 split 12.5 out — §12 has two open rows, not three, and 18
was the figure that was right. The second is the sentence that followed it:
**"nothing outside §12 is both open and unblocked" is no longer true**, and
§13's own text argues it was a fact about where this document had been looking
rather than about the tree. Six of §13's eleven rows are unblocked under every
route, because none of them is in the editor.

**§10.1 is still the whole of the critical path for the editor, and it is no
longer the whole of the critical path.** Ten of the twenty-eight open items are
behind it, it is a decision rather than work, and as of 2026-09-05 it has a
third option costed against a real spike rather than an argument. It is still
the single most valuable thing anybody could spend an hour on. What changed on
2026-09-09 is that it is no longer the only thing anybody could spend an hour
on — and §13.7, the row that made that point, **shipped the same day it was
written** (§2.46), which is the second time a §13 claim about where this
document had been looking was settled by building something rather than by
arguing.

**The Done figure jumped from 123 to 148 in one edit on 2026-09-05, and that
was a correction rather than a day's work.** By the same count §1 has always
used — top-level checkboxes in this file — 148 was already true before §12 was
written; the Open figure beside it was right, which is the tell. It is the
exact failure §7's second paragraph was added to stop, one section later and in
the other column: each commit fixed the row it owned and none of them owned the
sum. Recorded here rather than quietly changed, because a count that moves 25
in one edit is otherwise indistinguishable from a section that added 25 items.

**It happened again in miniature the same day, in the sentence above.** The
§12 figure stayed at "four" through 12.1 and 12.2 shipping and 12.5 being split
out, while the more detailed sentence below it said three — the two disagreed
for three commits. The arithmetic is now written out beside the numbers, which
is the cheapest thing that would have caught either of them.

Open, in full, so the shape is visible without scrolling: **no defects**
(§3.1 is empty again, and read the paragraph at the top of it before believing
that), **no unblocked work in §3.2**, **nothing left of the four halves §9
split out**, **four blocked** (§3.3 — a certificate's private key, an
autoscaler's cost model, a disk budget for snapshots, and an architectural
route; the backup destination came off on 2026-09-09, §2.47), **ten in §10 behind that same route**, **one in
§11** (11.1 through 11.9 all shipped 2026-09-05, the day after the section was
written — nine of its ten rows in one day, and 11.10 is the tenth; 11.2 also split 11.10 out of itself, and 11.4 named the
wrong interaction while doing it — see the rows. 11.9 shipped in two commits,
its dotfiles half and then its signing half, and was counted open in between:
a row is done or it is not, and half a row counted as done is how a count
stops meaning anything. 11.6 shipped before 11.5, which is the row that gives
it its urgency — the order is backwards and deliberately so: the protection
should exist before the exposure, not after, and 11.5's own document now asks
for the second factor to be turned on before the name exists), and **three in §12** (12.1 and 12.2 both shipped
2026-09-05, the day the section was written; 12.2 split 12.5 out of itself on
the way, so the section is one row shorter and one row longer than it started;
12.4 is unstartable without different hardware and has been set aside), and
**nine in §13**, of which four are unblocked under every route — the first
unblocked work this page has carried since 2026-09-05, and the reason the
sentence claiming there was none has been struck above. Two shipped on 2026-09-09, the
day the section was written: 13.7 (§2.46) and 13.8 (§2.48).

**§13 was written on 2026-09-09 and adds eleven, one of which shipped the same
day.** It is the fourth method
this file has used and a sharpened form of the weakest one: name the two
products this most resembles — CodeSandbox, and a personal VS Code on a server
— and diff against each. It deliberately repeats nothing from §10, §11 or §12,
and it says in its own opening which rows it is not re-opening. Six of its
eleven are unblocked by §10.1 because none of them is in the editor; its first
row is a terminal that its own socket closing kills, which is a defect wearing
a feature's clothes and was found the way §1 says the real ones are found — by
reading §11.7's dropped-connection handling against the container fix of
2026-09-04. It shipped that day (§2.46), and finding two further defects on the
way is the same method paying out twice more.

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

## 1a. What is built, and what is not

Added 2026-09-05, because §1 counts items and §2 tells stories and neither
answers the question somebody actually arrives with: *what does this thing do
today?* Every line below was checked against the tree on the day it was
written. **This section is a view, not a source** — if it disagrees with a
row, the row wins, and the disagreement is a bug in this section.

### Built and working

**The editor and the session.** Monaco with LSP for Python and Go, a terminal,
a live preview through a proxy, multi-file search and replace, cross-project
search, real-time collaboration with presence and follow-mode, checkpoints,
a test panel, an AI assistant, and an embeddable read-only view.

**The sandbox.** One Docker container per project, sized per workspace
(§12.1), started on demand and reaped when idle — unless the plan says
otherwise (§11.4). tini as pid 1, all capabilities dropped, no new privileges,
a private network, a pids limit, and a package cache on a named volume.
`devcontainer.json` is honoured for image, env, ports, lifecycle commands and —
under the personal plan — `mounts` (§11.2). Installs happen before somebody
waits for them when the workspace is already running (§12.2).

**Projects.** 13 templates, plus "Latest", which runs the real upstream
scaffolder inside the container instead of copying a pinned starter (§2.41).
Import from GitHub with the package manager the lockfile actually names
(§2.40). Open a folder that is already on the host (§10.2). Fork, export,
trash with undo (§9.1), and a delete that is not a mistake waiting to happen.

**Git.** Status, diff, stage, unstage, discard, commit, branches, remotes,
fetch, pull, push, and — since §11.9 — SSH-signed commits.

**Publishing.** Static and service deployments with history and rollback,
custom domains (the code half — §9.2), scheduled jobs, and managed Postgres
and Mongo per project.

**The account.** Plans and entitlements with per-account overrides (§8.1), a
usage screen with a per-project breakdown (§8.2), quota warnings before the
wall (§8.3), API keys (§8.6), an operator console with a moderation trail and
appeals (§8.7), a compute meter (§8.8), Stripe subscription state and webhooks
(§8.4, minus the two calls that need real keys), dotfiles that follow you into
every container (§11.9), and TOTP two-factor with recovery codes (§11.6).

**More than one container per project** (§11.3): a project's own
`docker-compose.yml` starts the services it declares beside it, on a private
internal network where the app reaches them by the names the file gave them.
Parsed rather than executed — a deliberate subset, with everything that would
hand a cloned repository control of the host refused and the reason shown.

**A way in from outside** (§11.5): a Caddy overlay and a Caddyfile, a written
answer that puts a tunnel first, and — the part that was a defect rather than a
setting — a `COOKIE_DOMAIN` without which every preview behind any reverse
proxy is refused silently, plus a boot check that refuses nine origin and
cookie combinations a browser would break without reporting.

**Offline tolerance** (§11.7): an installable shell with a manifest and a
service worker, a legible "you are offline" state, and unsaved edits kept
across a lost connection or a reload and offered back rather than replayed.

**Single-user mode** (§10.3), for a deployment with exactly one account and no
signup.

### Not built, and honest about why

**Waiting on one decision — the largest single thing here, and now ten of the
twenty-one open items.** Editor parity (§10.6–§10.14: debugging, extensions,
more languages, settings-as-files, tasks, a real diff editor, local history,
the rest of git, and the small ones) is all behind §10.1: Monaco,
openvscode-server, or **Route C** — attach your own editor over SSH. Route C
is no longer a proposal: §11.1's spike ran on 2026-09-05 and got the real VS
Code server running inside a sandbox with `ms-python.python`, Pylance and
debugpy installed, under the platform's full security posture. So the two most
expensive rows in §10 are reachable for 7 MB of image and one volume, and the
sentence "Route B can never reach extensions" is no longer true. Building any
of these by hand before the decision is waste, and that is the whole argument
of §10.

**Blocked on something outside this repository** (§3.3): a certificate's
private key, an autoscaler's cost model, a disk budget for snapshots. ~~And
note that *nothing* backs up a project today, which is the one entry on this
page that loses data rather than failing to add a feature.~~ **Backups shipped
2026-09-09 (§2.47)**: a nightly sweep to a directory the operator names, off
until one is, with a restore command and `docs/BACKUP.md`. What has not
happened is a host being rebuilt from one.

**Blocked on a decision nobody has taken.** Dev Container Features (§11.10) is
a question with three answers, none obviously right. Prebuilding a *stopped*
workspace (§12.5) needs three numbers somebody has to choose by watching a real
host. Teams (§8.5) needs a pricing decision and turns every `ownerId === userId`
into a membership question.

**Simply absent, and unblocked.** Notebooks (§12.3). GPUs (§12.4), which need
different hardware.

**Absent against the two products this most resembles** (§13, added
2026-09-09). Nothing here is in the editor, so none of it waits on §10.1. For
a *CodeSandbox*: there is no cheap project — every path into a working tree
ends at a container, so there is no anonymous sandbox (§13.1), no
container-free preview (§13.2), no URL per pull request (§13.3), no second
checkout of one repository (§13.4), no devtools for the previewed app (§13.5),
and no pairing link for somebody without an account (§13.6). For a *personal
cloud editor*: ~~a terminal is killed when its WebSocket closes, so closing the
laptop kills the build (§13.7)~~ — fixed 2026-09-09, §2.46; ~~secrets belong to
a project rather than to the account (§13.8)~~ — fixed 2026-09-09, §2.48; no credential inside the sandbox can clone a private
repository (§13.9); the editor has one mobile breakpoint and nothing else
(§13.10); and the session — tabs, splits, settings — lives in `localStorage`
rather than on the server it is connected to (§13.11).

### What is verified, and what is asserted

The distinction §5 exists for, restated because it is the thing most likely to
mislead a reader of the lists above.

**Run against real infrastructure:** every migration (all 37), the DB-gated
suites, container start and reap, both scaffolder paths, a signed commit
verified by `git log --show-signature`, a dotfiles clone and its failure mode,
TOTP enrolment through to a spent recovery code, §11.5's cookie behaviour
against a real server on three hostnames — including reintroducing the defect
and watching every preview go back to `401` — and §11.3's compose services,
where a real Postgres and Redis answered a real project's container by name and
a row survived being trashed and restored.

**Not run, and load-bearing:** the service worker has never registered — no
browser available here can — so §11.7's caching behaviour is asserted rather
than observed. §11.5's Caddy route has never faced a real domain: the Caddyfile
is validated by Caddy and the compose overlay resolves, but ACME issuance and
the WebSocket upgrade through the proxy have not been exercised, and the
wildcard-certificate build published sites need is described rather than built. Nobody has driven a real VS Code client through Remote-SSH into
a sandbox (§11.1's spike reproduced what that client does server-side, which is
strong evidence and not the same thing), and nothing has been tested behind the
egress gateway.
Nobody has run two differently-sized containers on one host and watched the sum
(§12.1). Nobody has scanned the two-factor QR with a real phone — the RFC 6238
vectors are the evidence there, and they are good evidence, but they are not
the same thing. And nobody has used this as their daily editor for a week,
which §10 warned about and which remains the largest untested claim in this
document.

---

## 2. Done

**A convention, added 2026-09-05 after it caused real confusion.** Entries in
this section carry the test counts and migration counts that were true **when
that entry shipped**, and they are left that way on purpose: they are the
evidence that the work was verified, and rewriting them every time a later
commit adds a test would destroy exactly that. **§1 is the only place with
current numbers.** Where an entry below says "all 35 migrations applied", read
"all 35 migrations that existed that day" — there are 37 now.

This is not a licence to let anything else drift. §7's rule is unchanged for
every claim about what the code DOES; it is only these two derived figures,
inside dated records, that are allowed to stay at their date.

**And a second convention, also stated late because it was never written
down.** §10, §11 and §12 record their own shipped rows **in place** — the row
is ticked and its own paragraph says what shipped — rather than getting an
entry here. §2.33–2.36 and §2.38–2.39 are the exception rather than the rule,
written when those sections were new. So **nine shipped rows are not listed in
this section**: §11.2, §11.4, §11.6, §11.8 and §11.9, plus §10's and §12's
that already have entries. If you are looking for what shipped and cannot find
it here, it is in the row itself. §1's count reads the checkboxes wherever
they are, so it is unaffected either way.

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

- All 35 migrations then in the tree applied; `migrate status` clean; six
  recipes seeded. (37 now — see the note at the top of this section.)
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

### 2.42 Since (2026-09-05) — a notebook, rather than the JSON it is stored in

§12.3, and the row said what it was worth before it said what it was: **worth
doing only if you write Python.** Opening a `.ipynb` here gave you the file — a
wall of JSON with a base64 PNG somewhere in the middle of it.

The distance really was a kernel protocol and a renderer, as the row guessed.
The sandbox already ran Python and already had an LSP for it, so nothing here
is a new language; it is a process, a wire format and a document view.

**The kernel starts on Run, not on open.** A language server connects as soon
as a Python file is on screen, which is right for something that only reads. A
kernel is a process holding whatever the user assigned to a variable, inside a
container whose memory limit the dev server is also living within — so opening
a notebook to read it costs nothing, and `KernelClient` connects on the first
send and queues until the socket opens. Without that queue the click that
starts the kernel is the one click that gets lost.

**Nothing renders `text/html`, and that is the decision in the renderer.** A
pandas DataFrame's nice output is HTML, and rendering it means markup from a
cloned repository running on this app's origin with this app's session. Every
`text/html` that matters carries a `text/plain` beside it, so the fallback is
the ASCII table rather than nothing. `image/svg+xml` is out for the same reason
wearing a less obvious costume. The markdown renderer follows
`notebookMarkdown.ts`'s existing stance: it produces nodes, never an HTML
string, so there is nowhere a `dangerouslySetInnerHTML` could be added.

**Cell editors are textareas, and that is a trade rather than a shortcut.** A
notebook has as many editors as it has cells, and a hundred Monaco instances in
one document is tens of megabytes of models. What it gives up is syntax
highlighting and the language server the row itself points at — worth
revisiting if notebooks turn out to be used for anything longer than a page.

**Outputs stream without saving; `done` saves once.** A cell printing in a loop
produces hundreds of messages, and a write per message is hundreds of
whole-file writes for one execution. And the file is written the way
`nbformat.write` writes it — one-space indent, sorted keys, source as an array
of lines — so the first save from this editor is not a diff touching every
line of somebody's notebook.

**The defect the real run found, which no test here would have.** The gateway
forwards the driver's messages verbatim, and the driver emits nbformat. nbformat
spells a stream output's text `text`; the in-memory type calls it `source`, and
that translation lived inside `parseNotebook`, so it applied only to text read
from a **file**. Every `print()` in a live notebook therefore rendered as an
empty box.

Nothing failed. Typecheck was clean because `KernelServerMessage` declared
`output: NotebookOutput` — an assertion about JSON off a socket that the type
system has no way to check and the wire had no obligation to honour. **And
every test agreed with the bug**, because each built its fixtures from the
in-memory type rather than from what the kernel sends. The wire type now says
`unknown`, `parseOutput` is exported so the live path and the file path go
through one reader, and the fixtures are the bytes `rc-kernel` actually
produced.

That is the second time in two sections that a type declaring what it wished
for hid a defect from a clean build — the first was `Project.scaffoldStatus`
being optional in 2.41. Both were found by running the thing.

Six mutants, all caught: rendering `text/html` after all, leaving the escapes in
a traceback, trusting a bad link scheme, carrying on past a failed cell in Run
All, leaving the last run's outputs under a cell running again, and trusting the
wire's declared shape. Three of those were written after a first pass survived,
which is the mutation testing doing its job rather than confirming a result.

**Verified against a real kernel on 2026-09-05.** `sandbox-python` builds at
**429 MB**, matching the figure the image comment claims; `rc-kernel` runs in
it, and driving it by hand returned `ready`, a `count`, stdout `42
`, an
`error` with a real `ZeroDivisionError` traceback, and `done` with `ok` false —
which is how the wire defect above was found. `execute_result` and
`display_data` matched the shared type exactly; only `stream` did not.

Server: 2263 passing, 296 skipped. Web: 1311 passing, up 84. Typecheck and lint
clean, 3/3. `localRoots.test.ts` stays red on this Windows host over symlink
EPERM, identically on a clean checkout.

**Not verified, and worth saying rather than implying otherwise.** Nobody has
opened a notebook in the browser: that needs an account, and creating one is not
something this session does. The gateway, the policy and the driver have been
exercised directly; the path from a click in the file tree to a rendered cell
has not. `NOTEBOOKS_ENABLED` also defaults to a single-tenant deployment only,
so on a shared one the whole feature is off until somebody sets it.

---

### 2.43 Since (2026-09-05) — "Latest" built a project the registry no longer described

Reported as "the preview is still not working", and it was: a project built
with **Latest** rendered "Preview unavailable" while its dev server was plainly
running in the terminal beside it. Every one of the six Latest recipes had it,
since the day 2.41 shipped.

**The whole defect in one sentence: Latest replaces the starter's files but
keeps the template id, and the registry describes the starter.** `registry.ts`
says so itself, in the comment on `expectsPreviewBase` — *"The starter
templates are written accordingly."* That sentence was true when it was
written and became a guess the moment a project could be built by
`npm create` instead. Three of its facts were then wrong at once:

- The starters' `vite.config` binds `0.0.0.0`; a generated one does not. So
  Vite listened on `[::1]:5173` **inside** the container while the proxy dials
  the container's address on the sandbox network. Proven rather than argued:
  from inside the container `localhost:5173` answered 200 and the container's
  own `172.25.0.3:5173` was refused.
- `HOST=0.0.0.0` is in the container's environment — `containerManager.ts`
  sets it, and the node image's comment says it is there so "dev servers must
  listen on all interfaces to be reachable from the proxy". **Vite 8 ignores
  it.** The env var was doing nothing and had been silently doing nothing for
  however long; the starters worked because their config said `host` outright.
- `expectsPreviewBase: true` makes the proxy forward `/preview/<id>/`
  unchanged, and a generated app serves at `/`. That one had not been reached
  yet, because nothing got past the connection refusal to hit it.

**What 2.41's verification actually established, and what it did not.** It
recorded "SCAFFOLDING → READY in 31s" and "Vite 8.2.2 against the starter's
6.1.0" — both true. Nobody loaded the preview. The step that would have caught
this is one line further on than the step that was run, which is the most
ordinary way for a verification to be honest and still miss.

**The fix writes the starter's config into the generated project**, and the
cost is worth stating rather than hiding: a "Latest" project carries a config
this platform wrote instead of the one its generator produced. It is the
narrowest deviation available — a generated Vite config contains the framework
plugin and nothing else, and the starter's contains that too. Copied from the
committed starter rather than re-stated in code, because the starter's is the
one known to work and a second copy is the same drift one level down. The dev
script gets the same flags, redundantly and deliberately: a flag survives
somebody editing a file we have just told them is theirs.

**The trap inside the fix.** Vite resolves `vite.config.js` before
`vite.config.ts`, so writing ours as `.ts` beside a generated `.js` would leave
both on disk and use theirs — a preview that stays broken with the fix
apparently applied. Every name the framework would resolve is removed first,
and that is a test rather than a comment.

Five mutants, all caught, including leaving the generated config beside ours
and letting a failed adaptation throw — which would mark a project FAILED for
a copy that did not work, when the scaffold itself succeeded. One of the five
needed a test written after it survived: the unknown-template guard, whose only
observable effect is not logging an error, because the catch below it already
made the project untouched either way.

**Verified on the reported project.** After the adaptation, Vite advertised
`Network: http://172.25.0.3:5173/preview/<id>/`, that address answered 200, the
served HTML carried `/preview/<id>/src/main.tsx`, and that asset answered 200.

Server: 2283 passing, 296 skipped. Typecheck and lint clean, 3/3.

**The import path was the other half of this, and is fixed separately in
2.44** — differently, because the answer there had to be different.

**Not fixed by this: projects already built with Latest.** The adaptation runs
during a scaffold, so anything created before it stays broken until its config
is edited or it is rebuilt. There is no backfill, and it is a real gap rather
than an oversight — rewriting a config in a project somebody has since edited
is a different decision from writing one into a project that is thirty seconds
old.

---

### 2.44 Since (2026-09-05) — the same defect on the import path, and why the fix is not the same

2.43 fixed a scaffolded project by writing this platform's config into it. An
imported repository has the identical problem — it binds localhost, and it
serves at `/` while `expectsPreviewBase: true` makes the proxy forward
`/preview/<id>/` — and **the same fix would be wrong.**

A scaffolded project's config is thirty seconds old and contains a framework
plugin. An imported repository's config is somebody's actual work: aliases,
proxies, build settings, things this platform has no business replacing. The
file says so, in a comment that predates all of this — *"A template's start
command is right for a project scaffolded from that template and usually wrong
for somebody's real repository."* That sentence was written about the start
command and is just as true about the config; nobody had applied it that far.

**So nothing is written to the clone. Everything is a flag on the command this
platform already owns.** Vite takes both `--host` and `--base` on the command
line, which is the whole reason an imported Vite app is fixable at all without
touching a file it did not write.

**The flags are derived from the template's own answer, not applied blindly.**
`previewBaseFor` returns the path only where `expectsPreviewBase` is true, and
null where the proxy strips the prefix — and null is a real answer rather than
an absence, because a `--base` added where the prefix is already stripped
applies it twice. A caller that passes nothing at all gets the command
untouched, which is what the scaffold path does: its config already carries the
base and would otherwise be given it twice by the other route.

**Matched on the start of the dev script, not anywhere in it.** A script like
`concurrently "vite" "node api"` mentions vite, and would have received the
flags itself — which does not misconfigure a dev server, it stops it starting.
`vitest` begins with the same five letters and is not a dev server either. An
unrecognised tool gets nothing, deliberately: a preview that cannot be reached
is a much smaller failure than a project that will not run.

**npm needs its separator and the other three do not.** `npm run dev --host`
is consumed by npm; `npm run dev -- --host` reaches the script. pnpm forwards
what follows the script name and warns about a `--` it does not need. That is
per-manager, so it lives beside the per-manager install and run commands that
2.40 already put there.

**One thing this does not fix.** Next has no flag for `basePath` — it is
config-only. So an imported Next app gets its host bound and still serves
`/_next/...` outside the preview prefix. **Fixed in 2.45, and the reason given
here for deferring it was half wrong**: the per-project column named as the
alternative would not have been enough on its own.

**The other limitation, stated plainly:** these flags arrive through the
**stored start command**, so they apply when a project is started by Run. A dev
server started by typing `npm run dev` in the terminal is the repository's own
command and is not reachable by the preview. There is no way around that
without editing their files.

Six mutants, all caught, including matching `vite` anywhere in the script,
dropping npm's separator, giving pnpm one it warns about, and adding a base
where the proxy strips the prefix.

**Verified with a stock config and flags only** — the state an imported repo is
actually in. A Vite dev server started with `--config` pointing at a
plugin-only config plus `--host 0.0.0.0 --base /preview/<id>/` advertised
`Network: http://172.25.0.3:5199/...`, answered 200 from the container's own
network address, emitted `src="/preview/<id>/src/main.tsx"` in its HTML, and
served that asset with a 200. Nothing but the flags did that.

Server: 2294 passing, 296 skipped. Typecheck and lint clean, 3/3.

---

### 2.45 Since (2026-09-05) — the column, and the half of the answer it was not

2.44 said an imported Next app could be fixed by making `expectsPreviewBase` a
per-project column instead of a per-template fact. **That was half right, and
the half it got wrong is the interesting one.**

Next emits `/_next/...` absolutely and has no flag for `basePath`. Set the
column to false and the proxy strips the prefix, so Next's *pages* resolve —
and every asset on them is then requested at the **origin root**, where the only
thing listening was a 404 saying this origin serves previews. `registry.ts` had
said so all along, in the sentence under `expectsPreviewBase`: *"Prefix-stripping
only works for apps whose assets use relative URLs; an absolute /styles.css
would escape the prefix."* The column moves the failure; it does not remove it.

So both halves. **`Project.expectsPreviewBase` is nullable and null means "ask
the template"** — which is what almost every project still says, because a
starter and an adapted scaffold were both built to match. It is set only where
the flags of 2.44 could not deliver the base, which today is exactly Next.
`canSetPreviewBase` is that question, asked of the same dev script
`detectStartCommand` will run — `devScriptOf` is exported so the two cannot
choose differently.

**And `createPreviewAssetRoute` serves the assets that then land at the root.**
The project comes from the `Referer`, which for a same-origin subresource is
the preview document that asked for it — not from the cookie, because somebody
with two previews open has one cookie and two projects, and guessing between
them serves one project's assets into the other's page. **The Referer selects;
it never authorises.** `authorisePreview` runs exactly as on the ordinary route,
so a forged one reaches only a project the cookie already opens, and it widens
nothing a sandboxed app could not already do: every preview shares this origin,
so a project's own script can already fetch `/preview/<other>/` directly.

**A test caught a real defect in the first version of this.** It was written as
a guard chained ahead of the proxy in one `app.use`. Express runs the handlers
in a `use` in order, so calling `next()` to *decline* landed on the next handler
in that same chain — the proxy — which has no target for the request and dials
its dead fallback address. Every request this origin could not identify would
have answered 502 instead of the 404 that says what the origin is for. Building
the route around the proxy and calling it explicitly makes declining mean one
thing. The refusal tests now assert the proxy was never reached, which is the
assertion that would have caught it.

**A second thing the tests caught, about the tests.** The first draft mocked
`authorisePreview` by spying on the module's namespace, which never intercepts
a call the module makes through its own binding. Three tests failed outright —
and one REFUSAL test passed while the mock was broken, because the real check
rejected a token the fake had never issued. It declined for a reason the test
was not about. **A refusal test that cannot tell "refused for my reason" from
"refused for any reason" is not testing anything**, which is worth writing down
because nothing about it looks wrong.

Ten mutants, all caught: ignoring the project's own answer, defaulting a
missing project to keeping the prefix, trusting a cross-origin Referer,
authorising nobody, dropping the CSP, proxying to a dead dev server, serving on
a path with no project in it, claiming Next accepts a base flag, and treating a
script that merely mentions `next dev` as Next.

One line is inert and is labelled as such rather than left looking
load-bearing: `keepsPrefix.set(req, false)` on this route cannot change the
outcome, because at the origin root `req.originalUrl` and the path the proxy
computes are the same string. It is set so the intent survives being mounted
somewhere else.

Server: 2317 passing, 296 skipped. Typecheck and lint clean, 3/3. The migration
is applied — 38 now, `migrate status` clean.

**Still not verified against a real imported Next app.** The pieces are tested
and the migration is real, but nobody has imported a Next repository and loaded
its preview. That needs a GitHub import, and it is the same one-step-further
gap 2.43 was written about.


### 2.46 Since (2026-09-09) — §13.7, the shell that a socket's close was killing

The first row off §13, and the one that section named as the thing to do if
only one thing got done. It is also the clearest case yet of the pattern §1
keeps stating: **it was found by reading two shipped things against each
other**, not by asking what a competitor has, even though it is written down
in a section built by asking exactly that.

**What was wrong.** `handleTerminalCreation` registered its teardown on
`ws.on("close")` and `ws.on("error")`, and that teardown called `hangUpShell`,
which SIGHUPs the shell's process group. So the WebSocket closing ended the
shell **and everything it had started**. Closing a laptop, a train tunnel, a
tab the OS discarded under memory pressure, a browser put to sleep, or fifteen
seconds of bad wifi killed a running `npm run build`, a migration, a `docker
compose pull` or a test run — with no record anywhere and nothing to come back
to. On the product whose whole proposition is that the work lives on a machine
you reach over a network, that made the network the one thing the work could
not survive.

**Why the code was like that, and why none of it could be reverted.** The
hangup is not incidental and it is not wrong. It closes a real leak, found on
2026-09-04 by looking at a running container — one of the three defects §3.1
records as having been predicted by nothing in this document. Docker keeps the
pty open when the stream goes, so before the hangup existed every closed
terminal left a `/bin/bash` behind: a dev server holding port 3000 that nothing
could see, `npm start` answering EADDRINUSE in a terminal that looked empty,
and zombies accumulating against a `PidsLimit` of 256. **The bug was never that
the shell is hung up. It is *when*.**

**And §11.7 had already decided this exact question the other way, the same
week.** A dropped connection is an ordinary event and not a decision by the
user, so unsaved edits are kept across one and offered back rather than
replayed. Two correct decisions, composing into a product where your *text*
survived the tunnel and your *build* did not. Neither decision was wrong on its
own, and nothing in either of them could see the other — which is the whole
argument for the method that found it.

**What shipped.** A shell now belongs to a **session**, not to a socket.

- `terminal/terminalSessions.ts`, new: a registry keyed by
  `userId:projectId:clientKey`. The user id is *in* the key rather than
  compared afterwards, so a valid key presented by the wrong person resolves to
  nothing rather than failing a check somebody could later forget to write.
- A disconnect **detaches** and starts a timer. A reconnect inside the window
  re-binds to the same pty. Only the timer hangs up, through the same
  `hangUpShell` on the same pid file — the leak stays closed, half an hour
  later instead of instantly.
- **A scrollback**, replayed on reattach, because reconnecting to a live pty
  with a blank pane and no way to know whether the build finished is barely
  better than a new shell. Bounded, oldest dropped first: a detached client
  applies no backpressure, so that cap is the only thing between a `yes` loop
  and this server's heap.
- **The session owns the container attachment**, not the socket. A detached
  session running a build is a real use of that container, and the idle reaper
  skips projects with attachments — so this is what stops the reaper stopping
  the container out from under the very thing this row exists to protect. It is
  also what bounds the cost: a forgotten tab pins a workspace for the grace
  window plus `CONTAINER_IDLE_MINUTES`, and no longer.
- `TERMINAL_DETACH_GRACE_SECONDS` (default 30 minutes), and **0 restores the
  old behaviour exactly**, without patching code. The default is chosen against
  what the window is for — a commute, a meeting, a lid closed between two
  buildings, all of which are minutes — rather than against "my build takes an
  hour", which is what the Run button is for and says so.

**Four things end a session, and naming them was most of the design.** The
grace window expiring; the shell exiting (`exit`, or the container going), in
which case there is no pty to come back to and holding the container would be
holding it for nothing; the container being stopped, removed, or rebuilt for a
changed environment signature — three call sites in `containerManager`,
because a session outliving its container holds an attachment against a
container that no longer exists and the reaper would then never reclaim the new
one; and **the client saying so**.

That last one is the half only the client knows. A socket that drops looks
identical from the server whether the user closed the pane on purpose or walked
into a tunnel, and closing a pane deliberately should hold nothing. So
`BottomPanel.closeTerminal` forgets the terminal's key and `BrowserTerminal`'s
teardown reads its absence as intent — no registry, no extra prop, and the
right answer for every other way a pane can unmount (navigating away, a
reconnect, a re-render), all of which leave the key in place.

**Two defects found in this work, and both are the kind this file says to
expect.**

1. **The access watch was keyed per terminal, and a terminal now has more than
   one socket.** `watchAccess` is a `Map` whose release deletes its key, and
   both sockets of a reconnect registered `terminal:<terminalId>` — so the
   departing socket deleted the watch belonging to the socket that replaced it,
   leaving a live shell that nothing was rechecking. That is precisely the hole
   `watchAccess` was written to close, reopened by giving a shell a second
   socket. Reliable rather than racy on the takeover path, where `attachSocket`
   closes the previous socket itself. Now keyed per connection. The test for it
   was checked by reintroducing the old key and watching it fail.
2. **Revocation stopped ending the shell.** Closing the socket *was* ending the
   shell before this, so `onRevoked` needed nothing else. It does now:
   `endUserSessions` runs before the close, or a person removed from a project
   would keep a shell running inside its container — and get it back if they
   reconnected inside the window.

**One thing got simpler rather than more complicated.** The client used to send
a bare newline on every connect, to make bash redraw a prompt printed before
the socket attached. Output produced while nobody is attached is now held and
replayed, so nothing is missed and the newline is not only unnecessary but
wrong: on a reconnect it is a keystroke pressed into whatever is running.
Deleted.

**Also guarded, because a shell outliving its socket is a shell a client can
accumulate:** `TERMINAL_MAX_SESSIONS_PER_PROJECT` (8), which gives up detached
sessions oldest-first and only refuses when every terminal on the project has
somebody attached and looking at it — and then says so, rather than closing the
socket with no reason.

Server: 2382 passing, 269 skipped — no database configured here, so read that
against §1's no-database row and not against its DB-gated one. Web: 1321
passing. Typecheck and lint clean, 3/3. No migration: sessions are process
state, and deliberately so — a restart has no pty to restore, and the shells a
crash leaves behind are what `reclaimShells` was already written to sweep.

**Not verified, and it is the load-bearing one.** Nobody has closed a laptop
mid-build and watched this work. §13.7 said that when it was written and it is
still true: what is tested is every branch of the session lifecycle against a
fake container, and what is not tested is the thing the row is about. The
container layer is also exactly where §3.1 records three defects that no test
and no section of this document predicted, all found by looking at a running
container — so the honest reading is that this needs an afternoon with a real
one before anybody calls it done.


### 2.47 Since (2026-09-09) — §3.3, the row that lost data

The second row off §14, and the one that section puts ahead of everything that
adds a feature: **the only open item in this file whose absence loses work
rather than failing to add something.** Before this, everything a user had lived
in exactly one place — the tree under `PROJECTS_DIR` and the rows in one
Postgres — and nothing copied either anywhere else, ever.

**The blocked half was one question, and it took a sentence.** §3.3 filed this
as blocked on a deployment decision with a cost attached: object storage off the
VM, a second disk, or a documented acceptance that this platform loses data when
its host does. §9's method is to ask which half needs a person and which half is
only code nobody wrote, and asked that way the answer is that **this server does
not choose.** `BACKUP_DIR` names a directory; whether that is a second disk, an
NFS or SMB mount, an `rclone mount` over a bucket, or a path something else
rsyncs off the host is a decision it has no information to make well. Empty is
off, like every other optional subsystem here.

**What it does decide is the one thing it can.** It refuses to start when
`BACKUP_DIR` shares a tree with `PROJECTS_DIR`, in either direction. That is the
whole class of mistake this feature invites: a backup on the same disk as the
thing it backs up answers "I deleted the wrong project" — which the trash
already answers (§9.1) — and not "the host died", which is the only question
this row exists for. It is also a mistake that *works*, every night, until the
day it does not, so it is fatal at boot rather than a warning.

**What a backup is.** Per project, under `<BACKUP_DIR>/<projectId>/<ms>/`: the
tree as a `tar.gz`, the project row and its collaborators, scheduled jobs and
database connections as JSON, and a manifest carrying a format version, the
archive's sha256 and the project's `updatedAt` at the moment it was copied. The
manifest is written **last** and is the completion marker — a directory without
one is ignored by everything, so a sweep killed halfway through leaves nothing
that could be restored from.

**Three deliberate departures from what a copy does**, each of which somebody
would otherwise "fix" by reusing the shared constant:

1. **`.git` is included.** `EXCLUDED_DIRECTORIES` drops it, correctly, for
   duplicates and exports. A backup is the opposite case: the history *is* the
   work, and a restore handing back a tree with no commits has lost most of what
   was there.
2. **A folder somebody opened (§10.2) has its row backed up and not its tree.**
   That tree is somewhere the operator already manages, and copying arbitrary
   host paths into a backup destination is a surprise nobody asked for. The
   manifest records the path and the reason, so a restore says what it did not
   restore rather than quietly producing an empty project.
3. **Trashed projects are backed up.** They are restorable until they are purged
   (§9.1), so skipping them would make the trash the place work goes to become
   unrecoverable.

**The restore is the half that makes the other half real**, and it is a script
rather than an endpoint because the case it exists for is a *new host*: no
session to authorise a request with, no dashboard to press a button on. It is
built around one rule — **never destroy anything to restore something** — since
a restore is reached for at the worst moment, usually by somebody guessing:

- `--list`, `--verify` and `--plan` change nothing, and `--plan` prints exactly
  what would happen before anybody consents to it.
- An existing tree is **refused** without `--force`, and with `--force` it is
  **moved aside rather than deleted**. If it was the wrong backup, what was
  replaced is still there.
- An archive that fails its digest is refused. That digest is the reason the
  manifest carries one: a truncated archive — a disk that filled mid-sweep, a
  mount that dropped — is otherwise discovered by restoring it, which is the
  worst possible moment and usually destroys the evidence.
- A row whose owner is not on this server is **not** written. The files are
  restored and it says so, rather than failing on a foreign key three frames
  down.

**Three defects found while building it, all by running it rather than reading
it** — which is §1's standing lesson arriving on schedule:

1. **The skip check compared a project's `updatedAt` to the wall-clock time the
   last sweep ran.** Semantically defensible and quietly fatal: a server whose
   clock steps forward — an NTP correction, a restored VM, a container with a
   skewed clock — sees every project as unchanged and **silently stops backing
   anything up**, which is this feature's worst failure and the one nothing
   would report. The manifest now records the source's own `updatedAt` and the
   comparison is between two values of the same column, which cannot skew. Found
   by a test that could not make a second backup happen.
2. **File modes were lost on unpack.** `fs.open(path, "w")` takes the process
   umask, so a restored `./deploy.sh` came back without its execute bit — a
   project subtly broken in a way that looks like the script being wrong.
3. **A restored tree belonged to whoever ran the command**, which on a fresh
   host is root. The sandbox runs as uid 1001 and bind-mounts that tree, so the
   project would open, list its files, and fail every write with `EACCES` — a
   restore that looks like it worked. `claimProjectForSandbox` now runs after
   the unpack, and says so in the warnings when it cannot.

**Visibility, because a backup system nobody checks is one that stopped working
some months ago.** `backups_completed` and `backups_failed` are counters; the
operator console's machine panel carries the last sweep's outcome; and the boot
log says which state it is in **in both directions** — "backups are OFF" at
warn, rather than leaving it to be inferred from silence. Two states are kept
apart deliberately on that panel: "on and never run" is rendered as a warning
and not as a tick, because a subsystem that is switched on and silent is the
exact shape of one that is broken. A sweep in which anything failed is reported
as failed, not as mostly-fine.

`docs/BACKUP.md` is the runbook, and its last section is what this does **not**
do: no global restore-everything command (on purpose — the first restore
anybody performs should be one they can read a plan for), no user accounts in
the backup, and nothing automated about moving the files off the machine.

Server: 2420 passing, 269 skipped. Web: 1325 passing. Typecheck and lint clean,
3/3. No migration: a backup is files on a disk and rows read out of the one that
already exists. One new direct dependency, `tar-stream`, which was already
present transitively under `archiver` — depending on that by accident is how an
unrelated upgrade removes your restore path.

**Not verified, and it is the load-bearing one.** Nobody has rebuilt a host from
this. What is tested is a real archive written to a real directory and unpacked
back out again — `.git` present, `node_modules` absent, contents byte-identical,
a truncated archive refused, an existing tree moved aside rather than replaced —
and that is genuine evidence for the mechanism. It is not evidence for the
runbook. The row is closed because the mechanism exists and is reachable; the
drill has not been done, and `docs/BACKUP.md` says so in its own text rather
than leaving somebody to find out on the day.


### 2.48 Since (2026-09-09) — §13.8, one key, typed once

The cheapest real row in §13 and the third thing off §14's plan. `envVars`
appeared **exactly once** in the schema, on `projects`, so one person with one
`ANTHROPIC_API_KEY`, one `NPM_TOKEN` and one database URL typed all three into
every workspace they made — and rotating any of them meant editing every
project by hand, which is the version of "rotate a key" that does not happen.

**Almost none of this is new code, and that was the argument for taking it
first.** The sealing, the validator, the reserved-name list, the length limits
and the "is this encrypted at rest" answer are all `projectEnvService`'s, and
this reuses every one of them rather than restating any: `sealAll` became
`sealEnvVars` and is now exported, because two copies of that function would be
two answers to "is this column encrypted" and the one that drifted would be the
one nobody was looking at. The column is on `user_personalization`, which is
already the table answering "what follows this person into every container" —
dotfiles and a signing key are there for the same reason.

**The merge order is the only genuinely new decision, and it is by
specificity**: account, then the managed database's URL, then the project's
own. An account value is the least specific thing anybody said; a database
provisioned *for this project* is not; a project variable is somebody choosing
for this project, and it wins. It is read inside `getEnvVars` rather than at
container start for the reason the managed database's URL is — `envSignature`
is computed from what that function returns, so changing an account secret
changes the signature of every project that owner has and each is rebuilt on
its next start, instead of keeping the old value for the rest of its life.

**The decision that actually mattered was about who can read a container.**
These go into every container of every project the account owns, *including
shared ones*, and an editor on a shared project can run `env`. That is not a
leak this introduces — it is what an editor already is, which is why
`getProjectEnvController` requires editor and says so — but the blast radius of
one mistake grew from one project to all of them. Two alternatives were weighed
and are recorded in the service so they are not re-proposed as fixes:
withholding account secrets from shared projects would mean **adding a
collaborator silently changes what a running container has**, breaking it at a
moment nobody would connect to the cause; and per-project opt-in lists are
GitHub's answer and a materially larger feature than the row asked for.

What shipped instead is that it is **said where the decision is made**. The
account panel names the number of the owner's projects that somebody else can
reach — and only when that number is not zero, because a standing warning about
a case that does not apply is one people learn to skip. The share dialog says
it again, next to the role selector, and only when there are secrets to leak
and the role being granted is editor. A share link that nobody has redeemed
counts toward that number: it is still a way in.

**One defect found on the way, in code this only borrows.** `envVarsSchema`
attached "Names must look like MY_VARIABLE" to the record's KEY schema, and
`z.record` reports a bad key as `Invalid key in record` and drops that message.
So anybody who typed `MY VAR` into a project's environment panel — for as long
as that panel has existed — was told nothing about what was wrong with it. The
name rule is now a refine and the message is the one that was always intended.
Found by writing a test that asserted on the message this feature would show.

**And the migration was run rather than written.** §5's sharpest entry is two
migrations that shipped green and had never been executed, because they wrote
`ALTER TABLE "Project"` where the table is `projects` — nothing in typecheck,
lint or the suite reads `migration.sql`, only Postgres does. There is no Docker
in this environment, but there are Postgres 16 binaries, so one was initialised
by hand and **all 39 migrations were applied from an empty database**. The
column is `envVars jsonb not null default '{}'` on `user_personalization`, read
back out of `\d` rather than out of the schema file.

That also made the DB-gated row runnable for the first time in this
environment: **2698 passing, 9 skipped** with `TEST_DATABASE_URL` set, against
all 39 migrations. The 9 are `egressProxy` and `serviceDeploy.e2e`, both of
which need a Docker daemon that is not here — so unlike previous runs of this
row, nothing is skipped for want of a database. Web: 1333 passing. Typecheck
and lint clean, 3/3.

**Not verified:** nobody has set an account secret and watched a container come
up with it. The merge is tested at the seam `getEnvVars` returns, which is what
`envSignature` and `runEnv` both consume, and that is good evidence — it is not
the same as reading the variable out of a running shell.

### 2.49 Since (2026-09-09) — §13.11, a session that follows the person

§14.3's Phase 2a, and the fourth thing off §14's plan. Four stores —
`editorSettingsStore` (sixteen preferences), `keybindingStore` (chord
overrides), `workspaceStore` (open tabs, expanded folders, pane sizes per
project) and `themeStore` — persisted to `localStorage`, which is per browser.
Open the same workspace from a second machine, **which is the reason the
workspace is on a server**, and it was a blank editor with default settings and
none of the keybindings somebody had spent a month building.

**What it is.** `user_editor_state`: a row per (account, store key), holding
whatever that store persisted, verbatim, plus a revision. `GET`/`PUT
/api/v1/account/session` on the account router beside dotfiles and secrets,
because a session belongs to the person. On the client, `lib/sessionSync.ts`
pulls once at sign-in and pushes a debounced patch when a store changes.

**`localStorage` is still there, and that is the design rather than an
oversight.** It stays the local cache and stays authoritative for first paint.
Making the endpoint the storage would mean an async `persist`, so the editor
renders with defaults for a frame and then jumps — and it would mean a
signed-out or offline browser having no settings at all, which is worse than
what we started with. So: `localStorage` for what this *browser* had, the
endpoint for what this *person* had, reconciled once at sign-in.

**Three rules, each with a test that fails without it** (verified by deleting
each guard and watching exactly the expected test go red):

1. A key changed on this machine since the page loaded is never overwritten by
   the pull. Without it, somebody who drags a divider in the second before a
   slow pull returns watches it snap back, which reads as the app fighting them
   — and they would be right.
2. Applying a pulled value must not look like a local change. The store's own
   subscriber fires while the value is being written in, and without a guard
   accepting the server's value would push it straight back — one request per
   machine per sign-in, forever.
3. A revision this browser has already applied is skipped, and the revisions
   are forgotten when the account changes. They are per account; a browser
   carrying the previous account's numbers would decide the new account's
   session was one it had already seen, and never pull it.

**The conflict rule, said out loud because there is one.** A row per key, so
two machines changing different things never touch the same row. Within one key
it is last write wins. That is not a merge and does not pretend to be: merging
two sets of open tabs produces an arrangement neither person asked for, and
"the thing I did most recently is what I see" is what somebody expects of their
own settings. `rev` exists so a client can tell its own write from somebody
else's, not to reject a write.

**A race was found while writing it and closed.** `useWorkspaceSession` reads
the remembered arrangement **once, at first render**, before the pull can have
landed. On a machine that has never opened this project there is nothing in
`localStorage`, so whether the second machine came back to your tabs depended
on which of two round trips won — that is, on nothing. The reopen now awaits
`whenSessionSettled()` (bounded, and a no-op when nothing is syncing, so an
offline browser still opens the project on time) and re-reads the store. Pane
`defaultSize` still comes from the render-time value, so on that very first
open the *splits* are default while the *tabs* are right; recorded rather than
hidden.

**The value is opaque to the server on purpose.** The shape belongs to the
client that wrote it; a server validating today's shape would reject a client
one version ahead of it, and the failure would be a browser that silently stops
saving. What the server does enforce is its own business: an allowlist of four
keys, so this cannot become a key/value store any browser writes anything into,
and 128 KB per value.

**Two more things a shared laptop forced.** Neither was in the row and both
are the kind of thing only writing it finds:

- **The first machine never uploaded.** It signs in, changes nothing, so
  nothing is ever pushed — and the second machine finds an empty account and
  concludes the person has no settings. After a pull, anything this browser has
  that the account has *nothing at all* for is adopted. Only where the account
  is empty for that key, so it can never overwrite what another machine stored.
- **Two people share a laptop more often than anybody designing this would
  like.** A `rc-session-account` marker holds whose session is in this browser.
  Sign in as somebody else and the four stores are reset and their storage
  removed first — reset *before* the removal, because `persist` writes on every
  `setState` and clearing first only writes the defaults straight back, which
  would then have been adopted into the second person's empty account. Without
  the marker the second person would see the first person's tabs for every key
  their own account had nothing for, and would upload them.

**One piece of copy was wrong the moment this shipped and was fixed with it.**
The editor settings dialog said changes "are remembered on this device". They
are not, any more.

**Deliberately not §10.9.** That row wants settings in *files* — committable,
diffable, per-workspace, importable from a real VS Code profile — and it is
behind §10.1. This is the *session*. §14.9 wanted this one first precisely so
that the file-backed one arrives into a world that already has an answer to
"where does a setting live", rather than the two racing to be the source of
truth.

**Verified.** Server 2712 passing / 9 skipped with `TEST_DATABASE_URL` (the 9
need a Docker daemon), web 1355 passing, typecheck and lint clean 3/3. The
migration was **run, not written**: all 40 applied against the hand-initialised
Postgres 16, and `\d user_editor_state` read back — composite primary key on
(`userId`, `key`), `rev` defaulting to 1, and the cascade to `users`.

**Not verified:** nobody has signed into two browsers and watched a tab layout
move between them. Every rule above is tested at the seam, which is good
evidence and is not the same thing.

### 2.50 Since (2026-09-09) — §10.1 decided, and Route C built

**The decision first, because everything below follows from it.** §10.1 had sat
open since the section was written: Monaco, openvscode-server, or make the
workspace attachable and let somebody bring their own editor. It is now **B +
C** — Monaco stays, and the workspace is attachable over SSH. Taken by the
repository owner's standing instruction to resolve every open decision rather
than ask; recorded in §10.1 itself with its reasoning and its costs.

**Why the third route wins the argument the first two were having.** §10 said
Route B was defensible only if multiplayer was the point, *because Route B can
never reach 10.7*. The §11.1 spike falsified that sentence — the real VS Code
server and `ms-python.python`, with Pylance and debugpy, run inside the sandbox
image over SSH. So the expensive half of Route A arrives for 7 MB of image and
one volume, without rebuilding run control and preview as extensions, and
without dropping the collaborative layer that is this product's actual
difference from the thing it is a clone of.

**What shipped.** `openssh-server` in all three sandbox images; an sshd started
per container as uid 1001 under the same `CapDrop: ["ALL"]` and
`no-new-privileges` every sandbox already has; public keys on the account, not
on a project; `GET`/`PUT /api/v1/account/ssh-keys`, `GET
/api/v1/projects/:id/remote`; an SSH keys panel beside Secrets, and a dialog
behind a command-palette entry that hands over the `ssh` command and a
`vscode://` link.

**The two things the spike found the expensive way, both handled.**
`~/.vscode-server` gets a named volume — it reached 1.3 GB after one extension
pack, in the writable layer that every environment-signature change throws
away, so without it an attach re-downloaded 229 MB per rebuild. And that
download is the first thing an egress-filtered sandbox refuses, so the dialog
and `SSH_EGRESS_NOTE` both say which hosts to allow rather than leaving somebody
to debug a silent hang in a client whose logs they cannot see.

**A defect this row nearly shipped, found by reasoning rather than by running.**
The sshd config first said `UsePrivilegeSeparation no` and
`ChallengeResponseAuthentication no`. Both read as exactly the right thing to
say — this daemon runs as the user it authenticates, so there is no privilege to
separate. **Both are removed options in the OpenSSH 9.2 that Debian bookworm
ships**, and 9.2 treats an unknown option as fatal: saying the true thing would
have stopped the daemon starting on every attach, and there is no Docker daemon
here to have caught it. There is now a test whose only job is to assert those
two strings are absent, because that is the only place the mistake is visible.

**Choices worth naming.** SSH is **off by default** (`SANDBOX_SSH_ENABLED`) —
it publishes a host port per running container, and an operator who did not ask
for that should not get it by upgrading. The port binds to **127.0.0.1** unless
`SANDBOX_SSH_BIND` widens it. Only the **owner's** keys are installed: a
collaborator already has a browser terminal, but a key outlives a session and a
revocation, and handing one over should be its own row with its own decision
rather than a quiet `OR`. And no forwarding of any kind — with the egress
gateway on, `AllowTcpForwarding` would be a hole straight through it.

**Verified.** Server 2766 passing / 9 skipped, web 1367 passing, typecheck and
lint clean 3/3. Migration **run**: all 41 applied, `sshKeys jsonb not null
default '[]'` read back out of `\d user_personalization`. Three guards checked
by deleting them and watching the expected test go red.

**Not verified, and it is the load-bearing gap:** no Docker daemon exists in
this environment, so nothing here has authenticated a real SSH connection. The
config, the script, the port mapping and the refusals are tested at their seams;
the daemon has never started. The §11.1 spike did run a real sshd and a real VS
Code server, which is why this is strong evidence rather than a guess — but the
first person to turn `SANDBOX_SSH_ENABLED` on is the first person to run this.

### 2.51 Since (2026-09-09) — §13.9, the credential that stays on your machine

§14.2's Phase 1d, and it took one line of sshd config because the row had
already done the thinking. `git clone git@github.com:me/private` — the most
ordinary thing anybody does on a new machine — failed in a sandbox, because
every credential this platform holds is deliberately unreachable from inside
one: the signing key is only ever offered for signing, dotfiles are cloned with
no credential on purpose, and `pushRemote` authenticates server-side with a
token the sandbox never sees.

**The decision, from the three the row named:** agent forwarding. It is the only
one that is not a secret sitting in a container that runs untrusted code, and it
became possible the same day, because §10.1 went to Route C.

**The line that matters is that this is not the forwarding that was refused.**
`AllowTcpForwarding` stays `no` — `ssh -L` out of a sandbox reaches whatever the
sandbox reaches, which is the one thing the egress gateway exists to control.
`AllowAgentForwarding` carries no tunnel: a unix socket over which the sandbox
may ask the user's own agent to sign a challenge. The key never leaves their
machine. Three tests hold that distinction, including one whose only job is to
check that turning agent forwarding off does not reopen TCP forwarding.

**Cost, stated where somebody will read it:** while connected, code in the
sandbox can use the agent for any repository that key opens. The dialog says so
in those words rather than in a link, and `SANDBOX_SSH_AGENT_FORWARDING=false`
is there for anybody who would rather type a token.

**And the half this does not fix.** The browser terminal is `docker exec`; it
has no agent and still cannot clone a private repository. Fixing that needs one
of the two options this row rejected. Chosen, not missed — and §13's inventory
now says so.

**Verified.** 28 tests on the config and the connection details, with the
agent/TCP distinction checked by turning the switch off and asserting TCP
forwarding stayed shut. **Not verified:** no Docker daemon here, so no agent has
been forwarded through a real connection.

### 2.52 Since (2026-09-09) — §12.5, building a workspace nobody has open

§14.3's Phase 2b. §2.39 shipped the half where the container is already
running; this is the first open of a workspace that has been stopped all week,
which is the case 12.2's own title described and did not cover.

**The row was never blocked on code. It was blocked on three numbers**, and it
says twice that choosing them without having watched a real host is how a
background task becomes the reason a machine is always busy. They are chosen —
under the standing instruction to decide rather than ask — and the honest thing
available was not to pretend they are measured: each is an env var whose default
is documented in `env.ts` **as a guess**, and the feature is off by default. An
operator who watches this misbehave retunes it without a deploy, and the number
that eventually proves right ends up written down.

**Each collision the row named, and its answer.** Memory is measured against the
same budget `assertFits` uses, not against a count of containers — a count says
nothing about a host running one large workspace. The sweep stops what it
started and only what it started, so a workspace somebody opens mid-sweep is
left alone. And it re-checks headroom *between* workspaces, because a sweep that
found the host quiet ten minutes ago is not evidence about the host now.

**Why it always stops what it started, even on a plan whose workspaces never
sleep.** That was the row's sharpest objection and the answer is not "the plan
allows it": a prebuilt container left running is indistinguishable, an hour
later, from one the user opened. It changes what the machine costs rather than
how fast it opens, and it corrupts the only signal the idle reaper has.

**What building it found that the row had not.** Deciding whether a *stopped*
workspace needs building was itself the problem. `warmStart`'s stamp lives in
the container's writable layer, so reading it means starting the container —
the exact cost this exists to avoid. So a prebuild now also records its
fingerprint against the project row, host-side, where the dependency files are
already readable because the tree is bind-mounted. A hint rather than a source
of truth: when it is stale the cost is one wasted start, and the container's own
stamp still decides what actually runs.

**Verified.** 19 tests on the gates, 2 more on the fingerprint, three guards
checked by deleting them. Server 2791 passing / 9 skipped, web 1369, typecheck
and lint clean 3/3. Migration **run**: all 42 applied, `prebuiltFingerprint
text` read back out of `\d projects`.

**Not verified:** no Docker daemon here, so nothing has actually started a
container, built it and stopped it. And the three numbers remain guesses — that
is the row's own warning and shipping does not answer it.

### 2.53 Since (2026-09-10) — §11.10, Features, and the root that stays in a box

§14.3's Phase 2c, and the last open row in §11. The row was explicit that it was
not one row of work but "a question with three answers, and picking one is what
unblocks it". Picked: **run the install scripts as root in a throwaway container
and commit the result.**

**The reasoning, because the other two are not obviously wrong.** Building from
a Dockerfile — option one — ends in the same place, but its input is arbitrary
code from a repository this platform did not write, which is exactly why
`build` and `dockerFile` are refused today. Option two's input is a Feature
artifact from a registry an operator allowlisted, run against a base image this
repository ships: a strictly smaller thing to have said yes to. Option three,
the home-directory subset, would refuse most real Features confusingly rather
than clearly, and the row is right about that.

**The sentence §11.2 wants kept is kept.** The workspace still never runs as
root and never gains a capability. Root lives in a build container with no bind
mount of the user's tree — so whatever the script does, it cannot touch the
project, which is the specific harm `privileged` is refused to prevent — with
capabilities trimmed to what `apt-get` genuinely needs and a lifetime of one
install.

**What is new code, and what it treats as hostile.** An OCI client of three
requests (token, manifest, blob); an options-to-environment mapping; and
`installsAfter` ordering. The registry is a host named in a file this platform
did not write, so: the blob is capped **while streaming**, because
`Content-Length` is the registry's claim rather than a fact; the layer's digest
is verified against what was actually read, which is the only thing that makes
"pinned by digest" mean anything; and every path in the tar is resolved and
checked to be inside the target, because this archive is about to be run as
root and `../../etc/cron.d/x` is not a theoretical entry.

**Two bugs found by writing the tests, both worth recording.** The unpacker
first rejected two promises for one bad archive — a `finish`/`error` promise
*and* `pipeline` — and the one nothing awaited is an unhandled rejection, which
in a server is a process that exits. Collapsing it to one holder then exposed a
race the tests caught immediately: `pipeline` can resolve before the async entry
handler has recorded WHY it refused, so an archive whose only entry was hostile
was accepted. The handlers are now chained and awaited, which is what makes the
check deterministic rather than usually right.

**And one of the tests could only pass once.** With the escape guard removed —
which is what a mutation check does — the archive really did write
`/tmp/escaped.sh`, and it stayed there and failed the next run. It now unpacks
into a folder inside a parent the test owns, so an escape lands somewhere it
deletes.

**Off by default**, with an allowlist of registries. The refusal string that was
correct for as long as this row was open now names the variable that turns it
on.

**Verified.** 42 tests, both path guards checked by deleting them. Server 2833
passing / 9 skipped, web 1369, typecheck and lint clean 3/3.

**Not verified, and it is the whole runtime half:** no Docker daemon and no
registry reachable here, so nothing has fetched a real Feature, run an install
script, or committed an image. The parsing, ordering, option mapping, image
keying, script generation and archive safety are tested; the build is not.

### 2.54 Since (2026-09-10) — §10.9, settings you can commit

§14.4's first Phase 3 row, and §10 called it "the row that most decides whether
the thing *feels* like a personal editor". `.vscode/settings.json`,
`.vscode/keybindings.json` and `.vscode/*.code-snippets` are now read from the
repository. Snippets did not exist at all before this.

**The names are VS Code's, and that is the feature.** `editor.fontSize`, not
`fontSize`. A `settings.json` somebody already has does something when pasted
in; one written here is not nonsense in a real VS Code. The mapping is a table
rather than a convention, so a setting VS Code has and this editor does not is
**reported** instead of silently dropped — and a section this editor has no
opinion about (`files.*`, `terminal.*`, an extension's namespace) is skipped in
silence, because reporting every line of somebody's real profile would bury the
one line that is a problem.

**Two settings differ in kind, not just in name**, and the table absorbs it:
VS Code's `wordWrap` and `lineNumbers` are strings where this editor has
booleans. Writing the test first caught the version of that which was wrong —
the enums were `["on","off"]`, so a perfectly valid `"relative"` or `"bounded"`
from a real profile would have been refused. VS Code's actual value sets are
there now.

**JSON with comments**, because that is what VS Code writes. A pre-pass rather
than a parser, and it respects strings — `"https://x"` is not a comment, and
treating it as one is the classic way this goes wrong. There is a test for
exactly that, and for an escaped quote inside a string.

**Precedence, decided once and reported.** Defaults, then the account (§2.49),
then the workspace file — the most specific statement wins, and a file committed
to the repository is more specific than a preference somebody carries between
machines. `origins` says which layer each value came from, because the settings
screen has to be able to say "this is coming from the repository": otherwise
somebody drags a slider, watches it snap back, and concludes the editor is
broken.

**§14.4 said do this after 2a or the two would disagree about the source of
truth. They do not**, and the mechanism is worth naming: the workspace values
live in a second store and are merged at the point of use. They are never
written into `editorSettingsStore`, so opening a project with a `settings.json`
does not permanently change that person's settings everywhere, including in
projects that never asked.

**Keybindings are read per-workspace, which VS Code does not do.** A deliberate
departure: this row's point is settings that are committable, and "F5 runs THIS
thing" is exactly the binding somebody wants in the repository. VS Code's
leading-`-` removal syntax is honoured as a removal rather than bound to a
command named `-run.toggle`.

**Snippet bodies are passed through untranslated.** Monaco understands VS Code's
own `$1` / `${1:name}` / `${1|a,b|}` syntax, so `InsertAsSnippet` is both less
code and more correct than any translation. The provider reads the current
snippets on every keystroke rather than closing over a list, so editing a
`.code-snippets` file takes effect immediately — and it registers on model
change as well as on mount, because one editor instance shows every file and
registering only for the first would give snippets that work in whichever file
you happened to land on.

**Verified.** 31 server tests, 7 web, and the false-versus-absent trap checked
by mutating `withWorkspace` to `||` and watching the right test fail. Server
2864 passing / 9 skipped, web 1376, typecheck and lint clean 3/3.

**Not verified:** nobody has pasted a real VS Code profile in and compared the
result against that profile in VS Code itself. The mapping is tested name by
name; it is not tested against a real file somebody uses.

### 2.55 Since (2026-09-10) — §10.13, the git you reach for in the second week

The daily loop was already complete. This is stash, blame, amend, revert, tags,
cherry-pick and comparing two refs — with stash and blame put where the work is,
because §10 named them the two somebody notices in the first week and a feature
you have to go looking for is one you use half as often.

**Stash is inline in the source control panel**, not in a dialog: it is what
somebody reaches for *instead of* committing, and hiding it would make the
cheaper option the harder one to find. Apply and pop are separate actions rather
than a checkbox — the primary one keeps the stash, and popping is confirmed,
because a stash you meant to keep and popped is recoverable only through the
reflog, which nobody reaches for in time.

**Blame annotates the end of each line** rather than opening a column. The same
answer VS Code arrived at, for the same reason: a blame column pushes the code
sideways and every line of it is the same three words. It is off until asked
for, because it runs a process per file.

**Amend refuses a commit that is already pushed.** `merge-base --is-ancestor
HEAD @{upstream}` is exactly the question "has anybody else seen this", and a
non-zero exit covers both "not pushed" and "no upstream", which are both fine to
amend. That check is the difference between a convenience and a way to lose
somebody else's work.

**Nothing here takes a ref as a free string.** A stash is addressed by index, a
commit by a sha checked against a hex pattern, and a branch or tag through the
`check-ref-format` the file already used. `execCapture` runs no shell, so there
is no quoting bug to have — but a value beginning with `-` is still a flag git
itself would read, and `--message=x` goes in as ONE argv entry so a message
starting with a dash cannot become an option. Four of those guards were verified
by removing them and watching the matching test fail.

**Two bugs the tests caught, both in this session's own new code.** The stash
panel first used `useQuery`, and `SourceControlPanel` is rendered without a
`QueryClientProvider` above it — so it threw "No QueryClient set" and took the
whole panel down. It reads with plain state now, the way the panel around it
already does. And the panel's existing tests mock the API module wholesale, so
adding calls to it made them `undefined()`; the mock lists them now.

**Deliberately not done, and named so it is not mistaken for an oversight:**
rebase, including interactive, and a commit graph. Rebase is history rewriting
with a conflict-resolution loop attached, and this platform's conflict UI is
built around merge; shipping a rebase that could strand somebody mid-operation
with no way out through this UI would be worse than not having it. The graph is
a rendering problem rather than a git one. Both stay open in §10.13's text.

**Verified.** 26 server tests, 5 web, four guards mutation-checked. Server 2890
passing / 9 skipped, web 1381, typecheck and lint clean 3/3.

**Not verified:** no Docker daemon, so every one of these has been tested at the
argv it builds and the output it parses, and none has been run against a real
repository.

### 2.56 Since (2026-09-10) — §10.11, a diff you can compare and type in

**One of this row's claims was wrong when it was written, and finding that out
is most of the work.** "grep for `createDiffEditor` returns nothing, so Monaco's
own side-by-side diff is unused" — the grep is accurate and the conclusion is
not: `@monaco-editor/react`'s `DiffEditor` wraps `createDiffEditor`, and it was
already rendering two cases, the assistant's review pane and compare-with-saved.
A row that measures a symptom can be right about the symptom and wrong about the
diagnosis; this one was.

**What was genuinely missing, and shipped.** The left-hand side is now a choice
— the saved copy, a branch or commit, or another file in the project — and the
right-hand side can be typed into. §10.11 asked for exactly that ("edit inside
the diff"), and a diff you can only read is one you have to leave in order to
act on.

**Reading a version that is not checked out** is `git show ref:path`, which is
the only way: the working tree holds one version at a time, and "compare against
main" is a question about one that is not there. A file that does not exist on
that ref answers **null rather than an error**, because "this file is new on
your branch" is an answer — the diff is against nothing and every line is an
addition. An error there would make a legitimate comparison look like a failure.

**Reading another file goes through the download endpoint that already exists**,
not a new route: same question, already scoped to `viewer`, already confined by
`resolveInProject`, and a second route would be a second place for that
confinement to be got right. Deliberately not through the editor socket — that
path OPENS A TAB, so using it to fetch a comparison would put the file you are
comparing against into your editor as a side effect.

**Two things that would have been wrong and are not.** The dialog subscribes to
the active tab rather than reading `getState()` during render, which would have
named whichever file was open when the page mounted. And switching files resets
the comparison: the left-hand side was fetched for the file that WAS open, and
keeping it would diff two unrelated files and look, for a moment, like a real
answer. The store drops its text when the SOURCE changes rather than when the
new text arrives, for the same reason — verified by removing that and watching
two tests fail.

**The original side stays read-only.** It is a version that is not checked out;
there is nowhere to write it. And the assistant's review pane stays read-only
too: its right-hand side is a PROPOSAL rather than the buffer, so editing it
would be editing something nobody is saving.

**Verified.** 4 server tests on `show ref:path` including a ref that could be
read as a flag and a path that climbs out of the project, 6 on the compare
store, one guard mutation-checked. Server 2894 passing / 9 skipped, web 1387,
typecheck and lint clean 3/3.

**Not verified:** nobody has typed into the diff and watched the file save. The
change path is the same `markDirty` + `queueIfAllowed` pair the main editor
uses, which is good evidence and is not the same as having done it.

### 2.57 Since (2026-09-10) — §10.10, tasks, and the panel's second feed

Named tasks, groups and `dependsOn` are the small half. The row itself points at
the large one: "the problems panel already exists and is fed only by the
language server, so the matcher half has somewhere to go." It does, and a build
error is now something you click rather than something you read in a terminal
and then go looking for.

**The matchers are named the way `tasks.json` names them** — `$tsc`,
`$eslint-stylish`, `$go`, `$gcc` — for the same reason §10.9's settings use VS
Code's names: a file somebody already has should work. Each has a test written
against **real output from the tool it names**, because a regex written against
imagined output is a regex that matches imagined output.

**Two lists, not one.** Task problems live beside the language server's rather
than merged into them, and the reason is lifetime: markers are recomputed on
every keystroke and replaced wholesale, while a task's problems are true until
that task runs again. Merging them would mean the next keystroke silently
deleting a build's errors — at the moment somebody most needs to see them. The
status bar counts both, because a count that omits the build says "everything is
fine" while the build is red.

**Background tasks are refused by name.** `isBackground` is a watch, and this
platform already has one notion of a process that stays running — the dev server
(§2.7), with a lifecycle, a log, a preview and a reconciler. A second would be
two answers to "what is running". The refusal says that, where the Run button
is, rather than starting something and abandoning it when the request ends.

**A dependency that fails stops the chain**, because a `build` that runs after
`install` failed reports the consequence rather than the cause. A cycle is
refused rather than broken, for the reason `orderFeatures` gives: an arbitrary
order produces a build that works here and not in VS Code.

**`execCapture` grew a timeout**, optional and absent by default so nothing else
changes. A task's command line comes from a file in the repository; a build that
hangs would otherwise hold the request open until the client gave up and leave
nothing to say why. It resolves with what it read and exit code 124 — the number
`timeout(1)` uses — rather than throwing the output away.

**One matcher was written and then deleted rather than shipped.** A Python
traceback line carries a file and a line and *no message* — the message is on
the last line of the traceback. A matcher built on it would fill the panel with
entries whose text is the traceback line, which is worse than an empty panel: it
looks like the feature works. The comment where it was says so, and says what
doing it properly would take.

**Verified.** 26 server tests, 12 web, two guards mutation-checked — and the
merged status-bar count was found *untested* by mutation, so it has tests now
rather than a claim. Server 2920 passing / 9 skipped, web 1399, typecheck and
lint clean 3/3.

**Not verified:** no Docker daemon, so no task has actually been executed. The
file parsing, ordering, matchers and path normalisation are tested; the exec is
not.

### 2.57b Since (2026-09-10) — §10.12, the history that was already being kept

**The row was half wrong and that is the finding.** It says checkpoints "are the
wrong granularity — whole-project, explicit". They are neither: `snapshot()` is
called per file, automatically, from the write handler, on every save, and has
been since §2.x. It even snapshots *what is being replaced* rather than what is
being written, with a comment explaining that the old version is the thing
somebody wants back an hour later.

**What was actually missing: a reader.** `listCheckpoints` and `readCheckpoint`
were written, correct, and reachable from nothing — no route, no client, no UI.
The data was on disk and the question "what did this look like an hour ago" had
no way to be asked. That is the second row this session where a claim measured a
symptom correctly and drew the wrong conclusion from it (§2.56 was the first),
which is worth noticing about this document rather than about these two rows.

**Opening a version compares rather than restores.** §10.11 made the diff pane's
left-hand side a choice earlier the same day, so an old version goes there —
and what somebody wants out of an hour-old file is usually three lines, not the
whole thing back.

**What the panel says out loud:** these live beside the project on the same
disk, so they are useful for the last hour and are not a backup. §3.3 is the
backup. A panel that implied otherwise would be the most expensive kind of
wrong.

**A test that claimed too much, corrected rather than kept.** `readCheckpoint`
validates `at` with `Number.isSafeInteger`, and a test asserted that guard
"rather than building a path from it" — but mutating the guard away leaves the
test green, because a bad number names a file that does not exist either way.
The test now states the outcome and records that the check is belt to that
braces. A test whose comment claims a mechanism it does not exercise is worse
than no comment.

**Verified.** 3 server tests, 7 web. Server 2923 passing / 9 skipped, web 1406,
typecheck and lint clean 3/3.

**Not verified:** nobody has saved a file, waited, and watched the version
appear. The reading path is tested; the snapshot half was already shipped and is
covered by its own tests from §2.x.

### 2.58 Since (2026-09-10) — §10.8, five more languages, and one that mattered

Two language servers became seven entries: TypeScript and JavaScript from the
node image, Rust and C/C++ from images added with this row.

**TypeScript is the one worth having and the row nearly undersold it.** It says
TS and JS "get Monaco's bundled worker, which is per-model and does not see the
project" — which is not a weaker intelligence but a different one. A rename
renames one buffer. Go-to-definition across files is a guess. `tsserver` behind
`typescript-language-server` sees the project, and it went into the node image
this platform already builds, so it cost one registry entry and one `npm
install -g`.

**A test warned about the mistake this row could have made, and it was
listened to.** An existing test said: naming an image for a language whose
image does not exist "would be a lie about an image that does not exist". The
tempting version of this row is registry entries for Rust and C++ pointing at
`sandbox-rust:latest` and `sandbox-cpp:latest` — which nothing builds, so the
refusal message becomes exactly that lie. So the Dockerfiles are here, they are
in `pnpm images:build`, and they are in CI, because an image nothing builds is
an image whose Dockerfile is wrong and nobody knows it. A test now asserts that
every image named in the registry is one the build produces.

**`image` became `images`**, because `typescript-language-server` serves two
language ids and a server can belong to more than one image. Mutating the check
to compare only the first image left every test green — every entry names one
image today — so `servesImage` is exported and tested directly. A capability
that is latent rather than exercised is one that breaks the day it is first
used.

**Two tests used Rust as their example of an unsupported language** and this row
made Rust supported. Their intent was untouched; the example moved to Ruby, with
a note saying so.

**Choices about the images themselves.** `rust-analyzer` comes from `rustup
component add` rather than a release tarball, so the analyzer and the compiler
are the same version — the pairing that decides whether it understands the
project's syntax. `clangd` comes from Debian for the same reason: an analyzer
that disagrees with the compiler about where `<vector>` lives is worse than
none. And `CARGO_TARGET_DIR` points into the cache volume, because a debug build
is hundreds of megabytes and rebuilding it on every container rebuild is the
waste the node_modules cache already exists to avoid.

**Not done, and named:** Java, C#, Ruby, PHP. Each is another image and another
server, and none has a template here to be used from.

**Verified.** 36 LSP tests, the image-list behaviour mutation-checked. Server
2929 passing / 9 skipped, web 1406, typecheck and lint clean 3/3.

**A flake was confirmed rather than assumed.** One run failed on
`refreshTokenService`'s concurrent-refresh test — which §1 already records as
failing "roughly one run in three" under load, untouched since well before it
was first seen. Re-run 3/3 green in isolation and green on the next full run,
and this change touches nothing near it.

**Not verified:** no Docker daemon, so `images/rust` and `images/cpp` have never
been built, and no `rust-analyzer`, `clangd` or `tsserver` has been started. The
policy is tested; the images are Dockerfiles nobody has run. CI builds them on
the first push that reaches it, which is where that gap closes.

### 2.59 Since (2026-09-10) — §10.14, and what a bundle row hides

Six items, and **two were already done when the row was written**: notebooks
shipped in §2.42, and editor splits have been persisting `editorSplitWidth`
since §2.x. That is the hazard of a bundle row — it is read as one unit and
ages as six.

**Markdown preview reuses §2.42's parser and renderer** rather than adding a
markdown library. The obvious move is `marked` plus `dompurify`, which is two
dependencies and an `innerHTML` in front of content from a repository this
platform did not write. `parseMarkdown` and `MarkdownBlocks` already exist and
already refuse a `javascript:` link through `safeHref` — a second markdown path
would be a second place for that refusal to be got right. What it does not
render, because the parser does not: tables, footnotes, block quotes, images,
HTML.

**A bug written and caught in the same hour.** The preview first read
`diffCurrent`, which is only set when the diff pane is opened — so it would have
shown the last SAVED text, silently, in the one case anybody looks at a preview.
The comment beside it said "previewing what you have typed is the whole point"
while the code did the opposite. It is fed from the live buffer now, updated
only while the preview is open so a hidden pane does not re-parse on every
keystroke.

**Terminal profiles read VS Code's own spelling** —
`terminal.integrated.defaultProfile.linux` plus the profiles map, with a
built-in name resolving to `/bin/<name>` as VS Code's shipped profiles do. The
value comes from a file in a repository this platform did not write and is
interpolated into a command line, so an **allowlist of absolute paths** decides
what may run; anything else is ignored in favour of bash rather than refused,
because a devcontainer naming a shell the image lacks should open a working
terminal, not none. A bare `zsh` is refused: PATH inside a sandbox is a thing
the project itself can change.

**The wrapper is `/bin/sh` now, and the reason is fish.** `shellArgv` wraps the
shell to record its own pid, and the first version of that comment claimed the
wrapper avoided running rc files twice — which is wrong, since a `-c` shell is
not interactive. The real reason is that `$$` is the pid in every POSIX shell
and is **not** in fish: a wrapper written in the chosen shell would record the
wrong pid for one of the shells this allows, and the pid file is what the hangup
uses. The failure would have been a shell nobody can kill — §13.7's defect
again, reintroduced by a feature.

**Two items stay open and are named in this entry** rather than left inside a
closed row: split terminal panes, and multi-root workspaces. The second is not
small — one project is one container, one bind mount and one quota, and a
second root is a second of each — and calling it small is how it ended up in a
bundle labelled "the small ones".

**Verified.** 21 terminal-shell tests, 5 config tests, 4 preview tests, the
allowlist mutation-checked. Server 2938 passing / 9 skipped, web 1410, typecheck
and lint clean 3/3.

**Not verified:** no Docker daemon, so no terminal has been opened with a
non-default shell. The argv is tested; the exec is not.

---

## 3. Open

### 3.1 Defects — code that is merged and wrong

The three deployment defects were fixed on 2026-08-29 (§2.8), and the last
entry here — public projects with no report mechanism and no review — was
closed on 2026-08-30 (§2.11).

**This section has now read "Empty" three times while merged code was wrong**,
and it is worth being precise about why, because the pattern is not bad luck.
**Thirteen defects have been found since it was emptied**, and not one of them
arrived by being written down first:

- a viewer could duplicate a project and take its environment variables (§2.14)
- `withTimeout` reported a crashed exec as a timeout (§2.15)
- `updateJob` never checked which project a job belonged to (§2.15)
- the two below.

Those five were found **by reading two shipped things against each other**.
The eight since were not, and the difference is the more useful half of this
paragraph — they were found **by running the thing**:

- three in the container layer on 2026-09-04, none of which any test or any
  section of this document predicted: an orphaned shell holding port 3000, a
  pid file that a reused terminal id could overwrite, and `sleep infinity` as
  pid 1 reaping nothing, so every terminal ever closed left a zombie against a
  `PidsLimit` of 256. All three had been there for the life of the project and
  all three were found by looking at a running container.
- a `select` in `listAccessibleProjects` that omitted `scaffoldStatus`, four
  files from everything that depended on it, leaving the whole client half of
  §2.41 dead. Typecheck was clean because the shared type declares the field
  optional, and an absent optional field is indistinguishable from an
  unfinished project.
- **two migrations that had never been run**, both writing `ALTER TABLE
  "Project"` where the table is `projects` — see §5. One had been committed and
  green for a day.
- `~/` expanding to `/home/sandbox/`, which is neither equal to the home
  directory nor outside it, so it walked past the refusal that stops dotfiles
  being cloned into `~` — where the script's first line is `rm -rf` (§11.9).
- an installer check written as a shell function called in an `if` condition,
  where `set -e` is suspended, so an `install.sh` that FAILED read as "no
  installer found" (§11.9).

**So: a list of known defects cannot prompt any of that.** An empty §3.1 means
"nobody has looked lately" and never "the code is right" — and "looked" now
demonstrably has to include running it against a real database and a real
container, not only reading it. Read the section that way.

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

- [x] **Backup and restore.** Shipped 2026-09-09 — see §2.47, and note what
      that entry does NOT claim: nobody has rebuilt a host from it. The row is
      closed because the mechanism exists, is tested through a real archive
      and a real unpack, and is reachable by a command with a runbook — not
      because the drill has been done.

      **The blocked half went the way §9 says blocked halves go.** "Where do
      backups live" was never a project; it was one question, and the answer is
      that this server does not answer it. `BACKUP_DIR` names a directory and
      the operator decides whether that is a second disk, an NFS mount, an
      rclone mount over a bucket, or a path something else rsyncs away. What
      the code DOES decide is the one thing it has the information to decide:
      it refuses to start when that directory shares a tree with
      `PROJECTS_DIR`, because a backup there works perfectly every night until
      the day it is needed. Original note follows.

      **Split by §9.1**, which takes the recoverable
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

**This section is the per-item order, and it is now mostly history.** It runs
item by item through work that is almost entirely struck through, and its most
useful part is the commentary underneath about how the work was found rather
than the list itself. **For what to build next, read §14**, which is the
programme-level plan across every open section; this one is kept because the
twenty-three entries below record *why* each thing was taken in the order it
was, and several of those reasons turned out to be the lesson rather than the
line.

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
21. ~~**§3.2 — showing people their quota.**~~ Done 2026-08-31 (§2.22), as
    part of §8.2 rather than on its own — which is why this line sat unstruck
    until 2026-09-05: the work was done under a different heading and nothing
    came back to close the line that asked for it. The cheapest thing here with
    a user on the other end of it: the numbers were already computed and
    already enforced, and the only reason nobody could see them was that no
    endpoint returned them.
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
markers in the ~51k lines there were that night (~116k now, still none —
§1). The defects it did find cluster on one thing nobody had
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

> **Closed 2026-09-05, and it was right.** Everything below was written as a
> warning that the schema was unverified while the code was. It stayed true for
> five days. When the migrations were finally applied — all 37, against a real
> Postgres — **two of them were broken**, and neither was one of the seven this
> note was about: §12.1's `workspace_size` and §2.41's `scaffold_recipes` both
> wrote `ALTER TABLE "Project"` where the table is `projects`, because the
> model carries `@@map`. The first `migrate deploy` failed on
> `relation "Project" does not exist`, and it failed on the one that had been
> committed and green for a day.
>
> The DB-gated suites then ran and passed: **2384 passing, 36 skipped** (§1).
> So the instruction at the end of this note was correct and following it cost
> nothing; not following it for five days cost two broken migrations sitting in
> `main`. The note is kept rather than deleted because the reasoning in it is
> the reusable part: **a mock cannot be wrong about a unique index, a foreign
> key, or a table name.**

`pnpm -r typecheck` clean 3/3, `pnpm -r lint` clean 3/3, 1536 server tests and
1003 web tests passing — all run, not quoted. *(Those were that day's figures;
§1 has current ones.)*

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

### 8.1 Entitlements — **shipped 2026-08-31, see §2.22**

**Was: unblocked, and everything else in this section depends on it.** The
marker was missing here and on 8.2 until 2026-09-05, while 8.3, 8.6 and 8.7
next to them carried theirs — so this section read as three of seven shipped
when it was five. The original entry follows unchanged.

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

### 8.2 The account screen — **shipped 2026-08-31, see §2.22**

`accountService.getAccountSummary` and `AccountDialog` are both in the tree,
with the per-project breakdown this row argued for. It has since grown three
more tabs — API keys (§8.6), Identity (§11.9) and Security (§11.6) — which is
worth noting because this row is now the place personal settings land by
default rather than a screen about quota.

**Was: unblocked. Closes §3.2's "quotas are enforced and never shown", and is
the reason 8.1 is worth anything.**

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

- [x] **Settle Monaco versus openvscode-server for the single-seat target.**
      **DECIDED 2026-09-09: B + C.** Monaco stays as the browser editor, and
      the workspace becomes attachable over SSH so somebody can bring their own
      VS Code, Cursor, Zed or `nvim`. Route A — replacing the editor with
      openvscode-server — is not taken.

      **Who decided, and on what authority.** The repository owner, who had
      this row put to them three times, instructed that the plan be completed
      without further questions and that every open decision be resolved on
      their behalf. This is that decision, recorded here rather than left
      implicit, and it takes the recommendation §14.1 already carried.

      **Why B + C rather than A.** The spike below is the whole argument. §10
      said Route B was defensible only if multiplayer was the point, *because
      Route B can never reach 10.7* — and the spike falsified that sentence:
      extensions and debugging both arrive over SSH, at a cost of 7 MB of image
      and one volume. So the expensive half of Route A is reachable without
      giving up the editor this repository controls, without rebuilding run
      control and preview as extensions, and without dropping the collaborative
      layer that is this product's actual differentiator. Codespaces ships both;
      so does this.

      **What it costs, stated so nobody rediscovers it.** 10.10, 10.12 and
      10.14 stay hand-built — Route C does nothing for them. Route C does
      nothing on an iPad, which is 13.10's problem and stays 13.10's problem.
      And it concedes, in writing, that the browser editor is not where the
      most serious work happens; it is what you open on a machine you do not
      control.

      **What this unblocks:** Phase 1b (Route C, properly — the sshd, the key,
      and the `~/.vscode-server` volume the spike found the expensive way),
      Phase 1d (§13.9, whose answer follows from the key Route C introduces),
      and all of Phase 3. It also *closes* 10.6 and 10.7 by another road: see
      those rows.

      The three routes, as they were argued before the decision, follow.

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

      **Route C — make the workspace attachable, and let the user bring the
      editor.** Added 2026-09-05 by §11.1, *after the spike that §11 said had
      to be run first*. An sshd in the sandbox image, a key the account owns,
      and the user's own VS Code, Cursor, Zed or `nvim` attaches directly. §11.0
      makes the argument; what follows is what actually happened when it was
      run, because the argument rested on a claim nobody had tested.

      **It works, under this platform's real security posture.** `sshd` starts
      as uid 1001 with `CapDrop: ["ALL"]`, `no-new-privileges` and tini as pid
      1, on a high port with a host key in the home directory — no root, no
      setuid, no privilege separation needed, because the user it authenticates
      is the user it already runs as. A key-authenticated session runs commands
      in the workspace.

      **And the expensive rows really do arrive.** The genuine VS Code server
      (1.136.1) — the same tarball Remote-SSH fetches — downloads, extracts and
      starts inside that container: extension host agent up, extensions folder
      initialised, HTTP answering. `ms-python.python` then installs from the
      marketplace, bringing **Pylance and debugpy** with it. That is 10.7 and
      10.6, the two most expensive rows in this section, arriving as working
      software rather than as a prediction.

      **Three costs the spike found that the argument had not.**

      *The image cost is trivial:* `openssh-server` is 7 MB on a 516 MB image.

      *The disk cost is not.* `~/.vscode-server` reached **1.3 GB** after one
      extension pack. And it lands in the container's **writable layer** —
      `Binds` covers `/home/sandbox/app` and `/home/sandbox/.cache` and nothing
      else — which `reconcileOnBoot` and every environment-signature change
      throw away. As it stands, attaching would re-download 229 MB and
      re-install every extension on each container rebuild. The fix is one line
      (a volume for `~/.vscode-server`, exactly as §2.x did for the package
      cache) but it has to be *in* the estimate, not discovered afterwards.

      *The spike did not test egress.* It ran on the default bridge with a
      published port, not on `SANDBOX_NETWORK` behind the egress gateway, and
      that 229 MB download is the first thing a filtered sandbox would refuse.

      What is still true from §11.0's honest list: Route C does nothing on an
      iPad, it concedes that the browser editor is not where serious work
      happens, and it leaves 10.10, 10.12 and 10.14 where they were. Nobody has
      driven a real VS Code *client* through Remote-SSH into this — the spike
      reproduced what that client does server-side, which is strong evidence
      and not the same thing.

      **What this does to the decision.** §10 argued Route B is defensible only
      if multiplayer is the point, *because Route B can never reach 10.7*. That
      sentence is now false: 10.7 and 10.6 both arrive over SSH, at a cost of
      7 MB of image and one volume. So staying on Monaco no longer costs you
      extensions and debugging, and the browser editor is free to be what it is
      already good at — the thing you open on a machine you do not control. A
      and C are not exclusive; Codespaces ships both.

      Route B is defensible if the multiplayer layer is the point of this
      product and the personal use is a side effect. Route A is defensible if
      the personal use is the point — **and it is now the more expensive of the
      two ways to get there**, since C reaches the same two rows without giving
      up the editor this repository controls. What is not defensible is
      building 10.6–10.14 by hand *while undecided*, which is the failure this
      row exists to prevent.

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
      ~~§3.3's backup-and-restore is filed as blocked~~ — **shipped 2026-09-09,
      §2.47**, and this paragraph is why it was taken first. Original note
      follows. §3.3's backup-and-restore is filed as blocked on a deployment
      decision about where backups go. At n=1 there is no operations team behind it and
      the host is somebody's laptop, so "this platform loses data when its host
      does" stops being an acceptable written trade-off. §9.1 shipped the trash;
      the backup half is still open and it moves up. **It moved up and it
      shipped — 2026-09-09, §2.47, taken first for exactly the reason this
      paragraph gives.**

---

### Blocked on 10.1 — parity, and free under Route A

Each row says what it costs on Route B, because that is the number the route
decision needs. Under Route A the cost of every one of them is zero.

- [x] **10.6 Debugging.** **Closed 2026-09-09 by §10.1's decision and §2.50's
      code, not by building it.** Route C ships debugging as the user's own
      editor doing what it already does: the §11.1 spike installed
      `ms-python.python` into the sandbox over SSH and it brought **debugpy**
      with it. Breakpoints, stepping, watch, call stack and `launch.json` are
      the client's problem, and the client is a real VS Code.

      **What is still true, and is not a footnote.** There is no debugging in
      the BROWSER editor and this row does not deliver one. Somebody on an iPad,
      or on a machine where they cannot install an editor, still cannot set a
      breakpoint — that is 13.10's territory and it stays open. What this row
      claimed was that the *platform* had no debugging at all, and that is what
      is no longer true.

      **What it would have cost to do the other way**, kept because it is why
      this trade is worth making: a hand-written DAP client, a breakpoint gutter
      and decoration layer, a variables/watch/call-stack UI, a per-language
      adapter in every sandbox image, and a stdio bridge through `docker exec`.
      Original note follows.

      No breakpoints, no stepping, no watch, no call stack,
      no `launch.json` — `grep` for `launch.json` or `DAP` over `apps/` returns
      nothing. Route B means a hand-written Debug Adapter Protocol client, a
      breakpoint gutter and decoration layer, a variables/watch/call-stack UI, a
      per-language adapter shipped into each sandbox image, and a stdio bridge
      through `docker exec` — every piece of which §6 decision 2's argument
      against `monaco-languageclient` applies to twice over. This is the single
      largest item in this section and the one Route A most obviously wins.

- [x] **10.7 Extensions.** **Closed 2026-09-09 by §10.1's decision and §2.50's
      code.** This row's whole claim was that Monaco cannot run VS Code
      extensions and no amount of work changes that — which remains true, and is
      now beside the point: over SSH it is the user's own editor running the
      user's own extensions with the user's own settings. That is *more* than
      Route A would have given, which is a marketplace inside somebody else's
      profile.

      The §11.1 spike installed `ms-python.python` from the marketplace into the
      sandbox and got Pylance with it, so this is measured rather than argued.

      **Still true:** no extensions in the browser editor, ever. A personal IDE
      is largely defined by the six extensions its owner cannot work without,
      and they now have them — in the window they attached, not in this one.
      Original note follows.

      **Unreachable on Route B.** Not "expensive" —
      decision 1's closing sentence is that Monaco cannot reach it at all, and
      §3.3 already lists "the user's own VS Code extensions" as out of scope for
      that reason. Worth stating as a row anyway, because a personal IDE is
      largely defined by the six extensions its owner cannot work without, and
      "we have a file-icon table" is not an answer to that.

- [x] **10.8 Languages past Python and Go.** **Shipped 2026-09-10 — §2.58.**
      Seven languages now: Python, Go, **TypeScript, JavaScript** (the node
      image, via `typescript-language-server`), **Rust** (`rust-analyzer`) and
      **C/C++** (`clangd`), with `images/rust` and `images/cpp` added and built
      in CI.

      **TypeScript is the valuable one and this row nearly undersold it.** The
      row notes that TS and JS "get Monaco's bundled worker, which is per-model
      and does not see the project the way `tsserver` does" — that is not a
      smaller version of intelligence, it is a different one: a rename is a
      rename in one buffer, and go-to-definition across files is a guess.

      **What is deliberately still missing:** Java, C#, Ruby and PHP. Each is
      another image and another server, and none has a template here to be used
      from. Original note follows.

      `lspPolicy.ts` knows two servers:
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

- [x] **10.9 Settings, keybindings and snippets that live in files.**
      **Shipped 2026-09-10 — §2.54.** `.vscode/settings.json`,
      `.vscode/keybindings.json` and `.vscode/*.code-snippets`, read from the
      repository, **in VS Code's own names** — `editor.fontSize`, not
      `fontSize`. That is the whole "bring an existing profile across" half of
      this row: a `settings.json` somebody already has does something when
      pasted in, and one written here is not nonsense in a real VS Code.

      **Precedence is VS Code's:** defaults, then the account (§2.49), then the
      workspace file. §14.4 was right that this had to come after 2a, and the
      reason is now in the code: a workspace value is applied at the point of
      use and never written into the person's own store, so opening a project
      with a `settings.json` does not permanently change their settings
      everywhere.

      Original note follows.

      `editorSettingsStore` persists sixteen preferences to `localStorage` under
      `rc-editor-settings`, and `keybindingStore` holds chord overrides the same
      way. That means: no `settings.json`, no per-workspace settings, nothing
      diffable, nothing committable, nothing that survives clearing site data,
      and no way to bring an existing VS Code profile across. Snippets do not
      exist at all.

      This is the row that most decides whether the thing *feels* like a
      personal editor, and it is the cheapest of the nine on Route B.

- [x] **10.10 Tasks.** **Shipped 2026-09-10 — §2.57.** `.vscode/tasks.json`:
      named tasks, build and test groups, `dependsOn` ordering, and **problem
      matchers feeding the panel this row said had somewhere to go** — which it
      did, and now has two feeds instead of one.

      **Background tasks are refused by name, with the reason.** VS Code's
      `isBackground` is a watch, and this platform already has exactly one
      notion of a process that stays running — the dev server, with a
      lifecycle, a log, a preview and a reconciler behind it. A second would be
      two things that can disagree about what is running.

      Original note follows. A project carries exactly one run command (§2.7 row 7,
      read from `package.json` at import) plus a test command (§2.18). VS Code
      has `tasks.json`: named tasks, build versus test groups, compound and
      dependent tasks, and problem matchers that turn compiler output into
      entries in the problems panel. The problems panel already exists
      (`problems.ts`, `ProblemsPanel`) and is fed only by the language server,
      so the matcher half has somewhere to go.

- [x] **10.11 A real diff editor.** **Shipped 2026-09-10 — §2.56.** Compare
      against a branch, a commit or another file, and **type in the diff** —
      the modified side is editable and its changes go through the same
      dirty-marking and debounced write as the main editor.

      **One line of this row was already stale when it was written**, and
      §2.56 says so: `createDiffEditor` returns nothing because the React
      wrapper is what is used, and `DiffEditor` was already rendering two
      cases. What was genuinely missing is what this shipped. Original note
      follows.

      `parseUnifiedDiff` plus `DiffView` renders
      `git diff` output; `grep` for `createDiffEditor` returns nothing, so
      Monaco's own side-by-side diff is unused. What is missing is the thing you
      reach for daily and not the thing you reach for at commit time: compare
      with saved, compare two arbitrary files, compare against a branch, and
      **edit inside the diff**.

- [x] **10.12 Local history, and a timeline.** **Shipped 2026-09-10 — §2.57b**,
      and **the row's own premise was half wrong**: checkpoints are neither
      whole-project nor explicit. `snapshot()` runs per file, automatically, on
      every save, and has since §2.x. What was missing is that **nothing could
      read them** — `listCheckpoints` and `readCheckpoint` existed with no
      route, no client and no UI, so "what did this look like an hour ago" was
      answered on disk and unreachable. A Timeline panel now reads them, and
      opening a version puts it in the diff pane (§10.11) rather than over the
      file.

      **What is still true from the row:** they are on the same disk as the tree
      they snapshot, so they are not a backup — §3.3 is, and the panel says so
      in those words. Original note follows. No timeline view and no per-file
      history. Checkpoints (§2.x) are the nearest thing and they are the wrong
      granularity — whole-project, explicit, and on the same disk as the tree
      they snapshot. VS Code's local history is per file, automatic, and answers
      "what did this look like an hour ago" for a file that was never committed,
      which is the question checkpoints do not answer.

- [x] **10.13 The rest of git.** **Shipped 2026-09-10 — §2.55.** Stash, blame,
      amend, revert, tags, cherry-pick and comparing two branches. **Not**
      rebase, interactive or otherwise, and not a commit graph — see §2.55 for
      why those two are named as not-done rather than quietly dropped.

      Stash and blame, which this row calls the two a personal user notices in
      the first week, are where the work is rather than behind a menu: stash is
      inline in the source control panel, blame is a palette toggle that
      annotates the lines in place. Original note follows.

      `gitService.ts` covers status, diff, stage and
      unstage, hunk staging, commit, log, branches, switch, discard, remotes,
      fetch, pull, push and conflict resolution — a genuinely complete daily
      loop. Absent: stash, blame, amend, revert, tags, cherry-pick, rebase
      (including interactive), a commit graph, and comparing two branches.
      Stash and blame are the two a personal user notices in the first week.

- [x] **10.14 The small ones, listed so they are not each rediscovered.**
      **Shipped 2026-09-10 — §2.59**, and the list had six items of which **two
      were already done when it was written**: notebooks (§2.42) and editor
      splits (`editorSplitWidth` has been persisted since §2.x). Shipped now:
      **markdown preview** and **terminal profiles**.

      **Still open, and named rather than left in a bundle:** split terminal
      PANES (terminals exist as tabs; two side by side is layout work in the
      bottom panel) and **multi-root workspaces**, which is not small at all —
      one project is one container, one bind mount and one quota, and a second
      root is a second of each. Both are carried in §2.59 rather than here,
      because a row that keeps two items alive after four are done is a row
      that will be re-read as four things still to do.

---

### Order

**Read §14.1 with this**, which recommends an answer to 10.1 (B + C) and says
what each of the three routes does to the ten rows behind it. What follows is
this section's own ordering, which stands whichever way that goes.

**10.1 first, and nothing from 10.6–10.14 before it.** That is the whole point
of the section: nine rows of hand-built parity are the wrong answer if the
answer is openvscode-server, and there is no way to find out by building one of
them.

Then, whichever way 10.1 goes:

~~**10.2 → 10.3 → 10.4 → 10.5.**~~ **All four shipped 2026-09-03** — §2.33
to §2.36. What is left in this section is 10.1 and the ten rows behind it. ~~Open-a-folder first~~ — done 2026-09-03
(§2.33), and the reasoning below held: the mount was an afternoon and finding
every place that assumes this server made the tree was the rest of it.
~~**Next is 10.3.**~~ Also done, the same day — this line was written between
two commits and never updated, which is the small version of the failure §7's
second paragraph is about. **Nothing in this section is next: 10.1 is a
decision, and the ten rows behind it are waiting on it.** Original note
follows.

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

- [x] **11.1 Put Route C in front of the §10.1 decision before it is taken.**
      Shipped 2026-09-05. The paragraph is in §10.1, and it is written against
      a spike rather than against an argument — which is what this section's
      own "what was verified" block insisted on, and it was right to.

      **Running it changed the entry.** Three things the argument had not
      costed: `openssh-server` is 7 MB, which is cheaper than expected;
      `~/.vscode-server` is 1.3 GB after one extension pack and lands in the
      container's writable layer, which every rebuild discards, so attaching
      would re-download 229 MB each time until it gets a volume; and the spike
      never touched the egress gateway, which is the first thing that would
      refuse that download. None of the three would have appeared in a
      paragraph written from the table.

      **What it proved.** sshd runs as uid 1001 under `CapDrop: ["ALL"]` and
      `no-new-privileges` with no root anywhere; the real VS Code server starts
      inside that container; and `ms-python.python` installs with Pylance and
      debugpy. 10.6 and 10.7 — the two most expensive rows in §10 — arrive as
      working software.

      Still not a build: nothing shipped into the product. An sshd in the
      sandbox image needs key management, per-account `authorized_keys` and a
      way in from outside, which is 11.5.

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

- [x] **11.3 Compose — more than one container per project.** Shipped
      2026-09-05, and built as the shape this row guessed at: **not compose
      support, but "the project's container, plus the services it declares, as
      one lifecycle unit"** — §6 decision 4's relationship with the managed
      database, generalised from one sidecar to several. A `build:` service is
      named and not started, because the project's own container already is
      that service, and nothing about how the app container is made changed.

      **It is parsed, not executed, and that is the whole design.** Handing
      `docker compose` a file out of a cloned repository is handing the daemon
      `privileged: true`, `network_mode: host`, `pid: host` and
      `volumes: ["/:/host"]` — an arbitrary-container-run primitive on the
      host, from a file nobody here wrote. Validating every key first is the
      only safe version of that, and once every key is validated the file has
      been parsed anyway. So: a deliberate subset, refused loudly rather than
      ignored quietly, exactly as `devcontainer.ts` does. A host path as a
      volume is refused rather than silently rewritten to a named one, because
      a quietly-relocated data directory is a nastier surprise than a message.

      **Each project's services get a private network, and that is the
      load-bearing decision.** The obvious build puts them on the shared
      sandbox bridge with a network alias equal to the service name, so the app
      reaches `db:5432` as compose promises. Every sandbox on this host shares
      that bridge — so two projects both declaring `postgres` would share the
      alias, Docker's DNS would round-robin between them, and one project's app
      would *intermittently* connect to another project's database. That
      network is `Internal: true` unconditionally, and not for tidiness: the
      project's container joins it as a SECOND network, and a routable one
      would be a hole straight through `SANDBOX_EGRESS_FILTERED`.

      **Two things only running it could have found, and both were wrong in
      code the tests were happy with.**

      *`CapDrop: ["ALL"]` breaks every official datastore image.* Postgres
      exits 1 with *"failed switching to 'postgres': operation not
      permitted"*, Redis exits 127 with *"setpriv: setresuid failed"* — both
      start as root, prepare a data directory and drop to their own user. Five
      capabilities go back: CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID. Still
      tighter than Docker's default set, and the omissions are pinned by a test
      as well as the additions — no NET_RAW, no MKNOD, and no
      NET_BIND_SERVICE, so nothing here can take a privileged port.

      *Trashing a project destroyed its database.* `removeServices` was wired
      into `removeContainer`, which is the path the TRASH takes — against this
      repository's own rule, stated in `projectService`: *"Held: the tree, the
      row, the managed database's volume. Restoring is worthless without the
      data."* A compose file's `pgdata` is that data. Split into
      `removeServices` (containers and network, rebuilt from the file in
      seconds) and `destroyServices` (the volumes, purge only), mirroring
      `managedDatabaseService.stop` / `.destroy`.

      **Proven end to end** against a real project: an app/Postgres/Redis file
      with a deliberately hostile fourth service, `db:5432` and `cache:6379`
      resolving and open from inside the project's container, PostgreSQL 17.11
      answering a real query on the file's own credentials, the sidecar unable
      to reach anything off its network, and a row written, trashed, restored
      and read back intact — then purged, taking the volume with it.

      **Off by default where anything is shared.** It is the one setting that
      multiplies one project into several containers, so
      `MAX_CONCURRENT_CONTAINERS` would quietly stop meaning what it says on a
      shared host; on by default in development and single-user mode, which is
      the argument `CONTAINER_MEMORY_MB` and `LSP_ENABLED` already make. Off,
      the file is still read and project settings still say what would have
      run.

      **The three subsystems this row warned about were not the problem.**
      `containerName`, `getPreviewTarget`/`publishedPorts` and the reapers all
      still assume one container per project and all still hold, because the
      project's container is still the only one they are about. What did need
      wiring is the lifecycle in both directions — start, stop, reap, trash,
      purge, shutdown and the boot sweep — and the boot sweep is the one that
      would have been missed: these are not named `rc-project-`, so nothing
      else on the host would ever have cleaned them up.

      **What is deliberately not supported**, and each is refused with a reason
      the user can act on: `build` for a second service, `env_file`, `extends`,
      `profiles`, `deploy`, secrets and configs, `container_name`, host-path
      volumes, host ports, and a `command` with shell syntax in it — that last
      because the command goes to the daemon rather than to `sh`, and running
      half of what a file asked for is worse than refusing it.

---

- [x] **11.10 Dev Container Features.** **DECIDED and shipped 2026-09-10 —
      §2.53.** This row was "a question with three answers, and picking one is
      what unblocks it". **The second is picked**: run the install scripts as
      root in a throwaway container and commit the result to a derived image the
      workspace then runs.

      **Why the second and not the first.** Both end in a derived image; what
      differs is the input. Option one means this platform builds from a
      Dockerfile — and `build` and `dockerFile` are refused *today* precisely
      because a Dockerfile is arbitrary code from a repository this platform did
      not write. Option two's input is a Feature artifact from a registry an
      operator allowlisted, run against a base image this repository ships. It
      is a strictly smaller yes, and it does not reopen the refusal 11.2 wants
      kept.

      **Why not the third.** It would refuse most real Features confusingly
      rather than clearly, which is this row's own objection to it.

      **The sentence this row is built around stays true.** The WORKSPACE never
      runs as root and never gains a capability; `privileged` and `capAdd` stay
      refused however personal this gets. Root exists only inside a build
      container with **no bind mount of the user's tree**, a capability set
      trimmed to what a package install needs (`CHOWN`, `DAC_OVERRIDE`,
      `FOWNER`, `FSETID`, `SETUID`, `SETGID` — not `SYS_ADMIN`), and a lifetime
      of one install. What 11.2 refuses is a workspace with power over the host.
      This is a build step with power over its own filesystem, which is what
      every image build is.

      **Off by default** (`DEVCONTAINER_FEATURES`), with
      `DEVCONTAINER_FEATURE_REGISTRIES` deciding whose code may run. An operator
      who did not ask to execute third-party install scripts on their host must
      not begin doing so because they upgraded — and while it is off, the
      refusal string is still the honest answer, now naming the variable that
      turns it on.

      Original note follows. Split out of 11.2 on 2026-09-05,
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

- [x] **11.5 A documented way in from outside, and the smallest one that is
      honest.** Shipped 2026-09-05. The row guessed that the app would have
      opinions about being exposed; it had one nobody had noticed, and it is a
      defect rather than a setting.

      **Previews would have been dead on arrival behind any reverse proxy.**
      The preview cookie is set by the API and spent on the preview origin.
      Locally those two differ by PORT — and cookies ignore ports, so
      `localhost:3000` and `localhost:3101` share one jar and the cookie
      arrives for free. Behind a proxy they differ by NAME, at which point a
      host-only cookie set on `api.example.com` is never sent to
      `preview.example.com`, `previewGuard` answers *"No preview session"* for
      every request, and **nothing anywhere reports it**: the browser stores
      the cookie and silently declines to send it. Signed in, editor working,
      preview pane empty, no line in any log. `COOKIE_DOMAIN` closes it, on
      that cookie only — the refresh cookie stays host-only, because nothing
      but the API ever presents it and widening a session credential to every
      sibling name buys nothing.

      **Demonstrated rather than reasoned about.** A real server on three
      hostnames and a cookie jar implementing the same RFC 6265 rules a browser
      does: with the fix, `preview_token` is stored for `.rc.test` while
      `refresh_token` stays host-only to `api.rc.test`, and a preview request
      carrying that jar gets past the auth gate. Remove the `Domain` attribute
      and the same request is `401`. The bug and the fix, both observed.

      **The `Set-Cookie` a browser dislikes is the failure mode of this whole
      area**, so the answer is a boot check rather than a paragraph.
      `config/exposure.ts` reads the three origins, the cookie policy and the
      proxy setting together and refuses to start on nine combinations that
      cannot work — two hostnames with no `COOKIE_DOMAIN`, `SameSite=None`
      without `Secure`, `Secure` on plain HTTP away from loopback, a
      `COOKIE_DOMAIN` that is an IP or a single label or does not cover the
      hosts it must, and the three origins collapsing into each other. Each
      exit names the consequence, not the rule.

      **Published sites must go on a second registrable domain, and that is
      now enforced.** §10 already argued the deploy origin cannot be the
      preview origin, because a preview is authenticated and a site is public.
      `COOKIE_DOMAIN` created a version of that nobody had: a cookie scoped to
      the shared parent is sent to every sibling, and a published site is
      arbitrary user code behind a name this platform hands out. Refused at
      boot.

      **The proxy-hops setting gets a second guard, because it cannot be
      checked at boot.** A plain-HTTP proxy on a LAN is indistinguishable from
      no proxy at all, so `middlewares/proxyHeaderWarning.ts` waits for the
      evidence and says so once when a forwarded header arrives with
      `TRUSTED_PROXY_HOPS=0` — the setting whose absence makes every rate limit
      key on the proxy, so one account's failed sign-ins throttle everybody. It
      names the header without logging what was in it.

      **The written answer gives the tunnel first.** `docs/EXPOSING.md` puts
      Tailscale or Cloudflare ahead of the proxy, because for a laptop behind
      NAT that is not a lesser answer — it is a stronger one, reachable only by
      devices already on your own network, with no inbound port and no
      certificate to renew. `deploy/Caddyfile` and `docker-compose.expose.yml`
      are the proxy route, as a working overlay on the LAN stack rather than a
      fourth copy of it, and the overlay unpublishes the base file's plain-HTTP
      ports — an API answering beside the TLS one is a way past every cookie
      and CORS decision above it.

      **Not verified: the Caddy route against a real domain.** The Caddyfile is
      validated by Caddy itself and the compose overlay resolves, but ACME
      issuance, HTTP/3 and the WebSocket upgrade through Caddy have not been
      exercised end to end, and the wildcard-certificate build that published
      sites need is described rather than built. `docs/EXPOSING.md` says so in
      its own words.

      One thing the row asked for that this deliberately does not do: it does
      not make exposure safe. It makes it possible to do deliberately. The
      document opens by saying what is actually being published — an editor
      running arbitrary code on a host whose Docker socket is mounted into the
      server — and asks for `SANDBOX_EGRESS_FILTERED` and the second factor
      before the name exists.

- [x] **11.6 Re-read the auth surface for an editor on the open internet.**
      Shipped 2026-09-05. §10.3's single-user mode was designed for a laptop
      and is honest about it, and it got the central thing right — *"a server
      that issued one to anybody who asked would be an unauthenticated server
      on whatever network it is reachable from"*, so sign-in stays even at n=1.
      11.5 is what makes that sentence load-bearing rather than cautious, and
      this is the rest of the thought: exposed, the threat model is not
      "somebody reads my code", it is `docker exec` on the machine with the
      source tree mounted.

      TOTP, offered and **not enforced**. On a laptop the network is the
      protection and a phone in the way, and this platform is in no position to
      decide which of the two somebody is running. What it can do is make the
      stronger option available and its state legible.

      The algorithm is forty lines in `lib/totp.ts` rather than a dependency,
      and the reason is proportion: the authentication path is the one place
      where a supply-chain compromise is indistinguishable from having no
      authentication at all. SHA-1, six digits, thirty seconds — not the
      strongest choices but the ones every app implements, because Google
      Authenticator ignores the `algorithm` and `digits` parameters of an
      otpauth URL outright, so a server using SHA-256 would produce codes that
      simply never match with nothing to say why. **Checked against all six of
      RFC 6238's own test vectors**, which is the only test in that file that
      could have caught a wrong implementation: everything else would pass just
      as happily against an algorithm agreeing with itself and with nothing
      else in the world.

      Four things carry the design, and each is a way second factors usually go
      wrong.

      **An unconfirmed enrolment is not protection.** The row exists from the
      moment somebody opens the setup screen, and treating that as a gate would
      lock the account behind a secret nobody wrote down. `requiresSecondFactor`
      asks for `confirmedAt`, not for the row.

      **A password alone produces nothing usable.** `login` answers a
      *challenge* — a distinct shape with no user and no token in it — and
      writes no cookies. The challenge is a JWT with its own `typ`, so
      presenting it as a bearer token is refused by the same check that already
      refuses the preview cookie; that check exists because those two were once
      interchangeable, and this is the third token to benefit from it. The
      account is named by the signed challenge and never by the request body,
      or the second step would be a way to trade a code for a session on
      anybody's account.

      **A code is spent when it is used.** A TOTP code is valid for a whole
      window, so without `lastUsedStep` one read over a shoulder — or captured
      in front of a phishing page — works again for the next thirty seconds.
      The confirming code counts too, so the code that enabled the factor
      cannot also be the one that signs you in.

      **The two operations that make an account weaker re-check the password.**
      Turning it off, and minting a fresh set of recovery codes — the second
      matters more, because ten permanent bypasses leave nothing looking wrong.
      An account with no password at all (GitHub sign-in) is refused rather
      than waved through: "there is nothing to check" is not "the check
      passed".

      Ten recovery codes, hashed rather than sealed because they are only ever
      compared — the same argument `user_tokens` already makes. Without them a
      lost phone is a permanently lost account on a deployment whose whole
      point is that there is no support desk. **And on a single-user
      deployment they are the only way back**: `SINGLE_USER_PASSWORD` and a
      restart rewrite the password and do nothing about this. The panel says so
      before anybody turns it on, which is where that belongs rather than in a
      document read afterwards.

      Verified end to end against the real database: sealed at rest, an
      unconfirmed row not treated as protection, a confirming code refused as a
      replay, the next window's code accepted and then spent, a recovery code
      good exactly once. What is NOT verified, and cannot be from here: that a
      real phone agrees. The RFC vectors are the evidence for that, and they
      are good evidence, but nobody has scanned the QR.

- [x] **11.7 The laptop lid.** Shipped 2026-09-05 — the three things the row
      asked for, and the third turned out to be the one that mattered.

      **Not losing the buffer**, which was worse than this row knew. Writes are
      debounced, and every flush ended at `emit?.(relPath, data)` — an optional
      call quietly doing the work of an error handler. Be precise about what
      that lost, because it is less than it looks and the difference is why
      this is two mechanisms rather than one: **socket.io already buffers**, so
      a brief drop with the editor still mounted was always survivable. What
      was not survivable is everything outside one socket's lifetime — the
      emitter being uninstalled on unmount (reachable by closing a tab with a
      keystroke on the clock), the socket being rebuilt by navigating away and
      back, reconnection attempts running out, and any reload or crash at all,
      since that buffer is in memory. So a write with nowhere to go is now kept
      and drained when a connection returns, and every queued buffer is
      mirrored to storage from the moment it is typed, cleared only when the
      SERVER confirms the save.

      **Nothing is ever written back to disk on its own.** Recovered work is
      offered, reopened into the tab marked unsaved, and saved by the ordinary
      path the user can see. Silently replaying a local buffer over a file
      somebody else has since edited would be a worse failure than the one
      being fixed, and it is what "restore my work" quietly means if nobody
      decides otherwise.

      **A legible offline state.** `navigator.onLine` and the socket's own
      state are tracked as two facts and kept apart, because the first is a
      claim about the network interface rather than about this server: it goes
      false in a tunnel and stays true on hotel wifi that has stopped routing.
      Conflating them gives the wrong message in both directions. A disconnect
      reads as "reconnecting" because socket.io retries, except when the server
      hung up deliberately, which it does not.

      **An installable shell**: a manifest, PNG icons rasterised from the
      existing `favicon.svg` by forty lines of signed-distance maths and a
      hand-rolled PNG encoder rather than a build dependency, and a
      hand-written service worker. Not generated: a build-time precache
      manifest buys a first-visit-offline guarantee this product cannot use
      anyway, since the first visit has to reach the server to sign in. What is
      wanted is that a RETURNING visit survives. Navigations are network-first
      so a deploy still reaches people; `/api/`, `/preview/` and `/socket.io/`
      are never cached, because a cached 200 for a request that should have
      401'd is a security bug rather than a stale page.

      **What is NOT verified, and it is the service worker.** Neither browser
      available here can register one — a one-line control worker fails
      identically to this one with "An unknown error occurred when fetching the
      script", which is the environment rather than the code. What was checked:
      the registration path runs and calls `register`, the script parses, the
      manifest is valid and its declared icon sizes match the PNGs' actual
      IHDR bytes, and all three files build and serve. The caching behaviour
      itself has never run. **Load it in a real browser before believing this
      row**, in the manner §5 requires.

      The layout half was further along than expected and was not re-derived:
      `index.css` already turns the side and bottom panes into overlay drawers
      below 900px, drops the drag dividers, and has a scrim (lines 1194–1235).
      **Monaco under a touch keyboard is still untested**, which is the part
      that decides whether the iPad case is real, and it is not part of what
      shipped here.

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

- [x] **11.9 An identity that follows you into the container.** Shipped
      2026-09-05, both halves. **Dotfiles.** Three settings on the
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

      **Commit signing — shipped 2026-09-05.** SSH signatures rather than GPG,
      which is what GitHub, GitLab and Gitea all accept now and what needs no
      keyring, no agent and no daemon inside a sandbox. An ed25519 key is
      pasted once, sealed with the same box the push tokens use, and used at
      commit time; the public half is derived and shown so it can be pasted
      into GitHub, without which a correctly signed commit still reads as
      "Unverified" and looks like a failure of this feature.

      Three decisions are worth the ink. The key is written to a private
      temporary directory under `/tmp` and removed by a `trap` whether the
      commit worked or not — under `/home/sandbox/app` it would have been in
      the user's repository, on the host disk, and in `git status`. Nothing is
      interpolated into that script: the key, the author and the MESSAGE all
      arrive as environment variables, so a commit message containing a quote,
      a newline or a `$(...)` is text rather than a command, and the key stays
      out of `/proc` for every process not owned by the container's user —
      the same property `pushRemote` already holds for its token. And the
      signing identity is the COMMITTER's, not the project owner's, for the
      same reason the attribution already is: a signature is a claim about who
      made this commit, and signing a collaborator's commit with the owner's
      key would be a false one.

      Two refusals, both at the point of paste rather than at the first commit.
      A passphrase-protected key is refused because `ssh-keygen -Y sign` would
      ask for the passphrase, nothing is at the other end of a `docker exec` to
      answer, and the commit would HANG rather than fail. And signing cannot be
      turned on without a key, because "signing is on" with nothing to sign
      with is a state the account screen could only describe as a bug. Reading
      those two facts needs the OpenSSH private-key header parsed by hand:
      Node's `createPrivateKey` throws `DECODER routines::unsupported` on a
      perfectly good ed25519 key, so it is no help at all. The public half is
      derived from that same header rather than asked for, and was checked byte
      for byte against what `ssh-keygen` itself wrote.

      `openssh-client` had to be added to all three sandbox images. Git's SSH
      backend shells out to `ssh-keygen`, and without it git says
      "cannot run ssh-keygen" and then "failed to write commit object" — two
      messages that name a symptom two steps downstream. With a bad key it says
      "gpg failed to sign the data", naming a tool that is not involved at all.
      Both phrasings were seen in a real container and both are translated into
      one sentence that says the thing a person needs: the commit was not made,
      and the work is still staged.

      Proven by running it. A real project, a real container and the real
      service path produce a commit that `git log --show-signature` calls a
      **Good signature**, with a multi-line message and an apostrophe intact,
      nothing left in the workspace, the key at rest as ciphertext — and, with
      signing switched off, an ordinary unsigned commit rather than a refusal.

      What is still absent, and deliberately: nothing forwards an `ssh-agent`.
      A key pasted here is a key this server holds. If 11.1's Route C ships an
      agent socket, that becomes the better answer and this becomes the
      fallback — which is the dependency this row always named.

---

### What was verified for this section

Checked against the tree on 2026-09-05, in the manner §5 requires.

**Re-checked at the end of that day, after five of these rows shipped.** Four
of the eight facts below stopped being true within hours of being written,
which is not a criticism of the reading — it is what a section does when it is
acted on the same week. Each is marked rather than silently corrected, because
which of them changed *is* the record of what shipped.

- `apps/server/src/index.ts:85` — `createServer(app)`, `node:http`. **Still no
  TLS in this process, and that is now the answer rather than the gap**: 11.5
  put TLS in Caddy in front of it, which is where it belongs — a Node process
  holding a private key and an ACME client is strictly more to get wrong.
  (Line 83 → 85.)
- `devcontainer.ts:119–140` — the ten refusals quoted are the actual strings.
  **Still ten, and two of them changed.** `mounts` is no longer unconditional:
  11.2 made it a plan capability, so the same map yields a shorter refusal list
  under the `personal` plan. And `dockerComposeFile`/`service`/`runServices` no
  longer say *"This platform runs one container per project"* — 11.3 made that
  sentence false, so they now refuse the devcontainer spec's compose
  INTEGRATION and point at the project's own compose file, which is read
  separately. (Lines 88–110 → 119–140.)
- The idle reaper — **changed by 11.4.** It was `activeAttachments === 0` and
  `CONTAINER_IDLE_MINUTES`, default 20 (`env.ts:408`); it now asks
  `idleAllowanceMs(projectId)` (`containerManager.ts:1081`), which the personal
  plan can answer with "never". It still calls `onProjectReaped` for the
  database pair.
- `searchService.ts` — **changed by 11.8.** `searchProject` was the only
  exported search; `searchAcrossProjects` is now beside it at line 197, which
  was the whole of that row.
- `grep -ril "totp|twoFactor|mfa"` over `apps/server/src` — no hits.
  **Changed by 11.6**, which shipped TOTP that day: `lib/totp.ts`,
  `service/twoFactorService.ts` and a `user_two_factor` table.
- `grep -rn "gpgsign|SSH_AUTH_SOCK|ssh-agent"` over `apps/server/src` — no
  hits. **Half changed by 11.9**: `gpg.format=ssh` and `user.signingkey` are
  both in `gitService.ts` now. `ssh-agent` and `SSH_AUTH_SOCK` still return
  nothing, and that half is deliberate — a key pasted here is a key this server
  holds, and agent forwarding is 11.1's to bring.
- `apps/web/public` — two SVGs, no manifest, no service worker. **Changed by
  11.7**, which added a manifest, three PNG icons, an apple-touch-icon and
  `sw.js`.
- `index.css:1194` — the ≤900px drawer layout exists, contrary to what a
  section about mobile would otherwise have assumed.
- `apps/server/templates` — 13, as §10 says. **Still 13**: §2.41 added a
  `scaffold_recipes` table beside them rather than more directories, which is
  the point of that row.

**~~Not verified, and load-bearing for 11.1~~ — run 2026-09-05, and it held.**
This said nobody had put an sshd in a sandbox image and attached a real editor
to it, and that the spike had to happen *before* 11.1's paragraph went into
§10.1. It did, in that order, and the insistence earned its keep: the spike
found three costs the argument had missed — see 11.1 and §10.1. sshd runs
unprivileged under the full posture, the genuine VS Code server starts inside
the container, and `ms-python.python` installs with Pylance and debugpy.
**What remains untested** is a real VS Code client driven through Remote-SSH
(the spike reproduced what it does server-side), and the whole thing behind the
egress gateway rather than on the default bridge.

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

- [x] **12.5 Start a stopped workspace to build it.** **Shipped 2026-09-09 —
      §2.52**, with the three numbers chosen rather than measured, and that
      distinction is carried into the code: `PREBUILD_MAX_COMMITTED` (0.6),
      `PREBUILD_RECENT_DAYS` (7) and `PREBUILD_STOP_AFTER` (true) are env vars
      whose defaults are documented **as guesses**, and the feature itself is
      off by default (`PREBUILD_STOPPED`). This row's warning is not resolved
      by shipping it — it is preserved in the one form that lets the first
      operator to see it misbehave retune it without a deploy.

      All three collisions it named have an answer: headroom is measured in
      MEMORY against the same budget `assertFits` uses, not in a count of
      containers; the sweep stops what it started and only what it started; and
      it re-checks headroom between workspaces rather than once at the start.

      **One thing this row did not foresee, found by building it.** Deciding
      whether a *stopped* workspace needs building was itself the hard part:
      `warmStart`'s stamp lives in the container's writable layer, so the only
      way to read it is to start the container — which is the cost the feature
      exists to avoid. A host-side copy of the fingerprint on the project row
      fixes it, and is a hint rather than a source of truth: stale in the safe
      direction, with the container's own stamp still deciding what runs.

      Original note follows. Split out of 12.2 on
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

- [x] **12.3 Notebooks.** DONE (2026-09-05), see 2.42. Was: zero occurrences
      of `notebook` or `ipynb` anywhere in `apps/` or `packages/`. It appears twice in this document, both times
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

Checked against the tree on 2026-09-05, in the manner §5 requires — and
**re-checked at the end of that day**, after 12.1 and 12.2 both shipped. Three
of the six are now the history of those two rows rather than facts about the
tree, and they are marked rather than corrected away, because which ones
changed is the record of what was built.

- **Changed by 12.1.** It was `containerManager.ts:593–597`, where `Memory`,
  `MemorySwap` and `NanoCpus` all read the global `env` values with no
  per-project term. They now read `size.memoryMb` and `size.cpus`
  (`:625`, `:628`, `:629`), resolved per project by `workspaceSizeService`.
- **Changed by 12.1.** The second call site named in that row — the bare
  `env.CONTAINER_MEMORY_MB` — is now the FALLBACK inside `resolveSize`
  (`:526`), which is where a project nobody has sized still gets the
  deployment's default. That was the point: one place decides, and the old
  constant became its default rather than its rival.
- `env.ts:378–382` and `:427–430` — `CONTAINER_MEMORY_MB` defaults to
  `unshared ? 2048 : 512` and `CONTAINER_CPUS` to `unshared ? 2 : 0.5`;
  `unshared` is `inDevelopment || soleTenant` (`env.ts:46`). **Unchanged**, and
  still the fact that corrected 12.1 downward.
- `grep -rniE "\bgpu\b|nvidia|DeviceRequests|cuda"` over `apps/server/src` and
  `packages/shared/src` — **0 hits. Unchanged**; 12.4 is blocked on hardware.
- `grep -rniE "notebook|ipynb"` over `apps/server/src`, `apps/web/src` and
  `packages/shared/src` — **0 hits. Unchanged**; 12.3 is open.
- **Changed by 12.2.** `warmStart.ts` existed with tests, and nothing in it was
  triggered by anything but a session starting. `containers/prebuild.ts` now
  is, from `index.ts` — which is exactly the gap that row named, and 12.5 is
  the half of it that is still open.

**Not verified, and it is the load-bearing one for 12.1:** nobody has run two
containers of different sizes on this host and watched the sum. The arithmetic
argument against decision 15 is a paragraph, not an experiment, and the failure
mode it is reasoning about — an OOM kill in somebody's terminal — is precisely
the kind §1 says a mock cannot be trusted about.

---

## 13. The two products this is not yet

Written 2026-09-09, from a reading of the whole tree against a question the
previous four sections do not ask: **name the two products this most resembles,
and diff against them.** CodeSandbox, and a personal VS Code that happens to
live on a server.

**This is the fourth method this document has used, and it is a variant of the
weakest one.** §12's closing table names three — reading two shipped features
against each other (finds defects), reading a policy and asking who it is for
(finds expired posture), and asking what a category has that this does not
(finds absences). This section is the third, sharpened by naming the category
instead of leaving it implicit, and it inherits the third's whole weakness:
**asking what a competitor has produces long lists cheaply, and most of any
ecosystem's features are not wanted by any particular person.** The defence is
§12's: every row below says who it is for, and the rows whose honest answer is
"possibly nobody here" say so in their own text rather than in a footnote.

**What this section is not.** It is not a second §10. §10 asks what VS Code
does that Monaco cannot and finds ten rows behind one route decision; §11 asks
which of the sandbox's refusals expired at n=1; §12 asks what a machine in a
datacentre does that a laptop does not. Every row those three already carry is
**deliberately absent here**, and where a row below touches one it says which
and why it is not the same thing. In particular this section does **not**
re-open: debugging or extensions (§10.6, §10.7 — behind §10.1), settings as
files (§10.9), tasks (§10.10), the diff editor (§10.11), local history
(§10.12), stash and blame (§10.13), multi-root and markdown preview (§10.14),
process snapshots (§3.3), backup (§3.3), teams (§8.5), autoscale (§3.3),
a CLI or GitLab (§3.3, out of scope), or GPUs (§12.4).

**And one thing this section changes about §10.1 without touching it.** Six of
the eleven rows below are unblocked under every route, because none of them is
in the editor: a terminal that outlives its socket, a secret that outlives its
project, a URL per pull request. §10.1 blocks ten rows and it blocks none of
these. That matters because §1 has said "nothing outside §12 is both open and
unblocked" since 2026-09-05, and this section says that is a fact about where
this document has been looking rather than about the tree.

---

### 13A. CodeSandbox — the part that happens in a stranger's browser

The organising observation, and it orders all six rows: **this platform has no
cheap project.** Every path into a working tree — twelve templates, "Latest",
a GitHub import, a fork, an opened folder — ends at a Postgres row, a directory
on the host, and a 512 MB container with an `npm install` in front of it. That
is the right shape for the thing somebody works in all day, and it is the wrong
shape, by two orders of magnitude of cost, for the thing CodeSandbox actually
sells: a URL you paste into an issue that renders a running React app in a
second, for a reader who has no account and will never come back.

The two anonymous surfaces that exist are careful and deliberately small.
`pub.ts` serves a gallery of public projects; the embed serves a project's
source beside its **published deployment**, and §2.x is explicit that framing a
container instead was refused on purpose — "an anonymous page view must not be
able to start one on the owner's behalf". That refusal is right and every row
below is written to respect it rather than to argue with it.

- [ ] **13.1 A sandbox a stranger can open, run and fork with no account.**
      The defining act of the product this section names, and the one thing
      here that is a product decision before it is code.

      Today: `assertProjectAccess` is in front of every project route, share
      links redeem into a `ProjectCollaborator` row that needs a `userId`
      (`projectAccessService.ts:457`), and the two surfaces with no session
      behind them are read-only by construction. So the shortest path from
      "somebody sent me a link" to "I changed a line and ran it" is: sign up,
      verify an email, fork.

      **For:** anybody who wants a bug reproduction other people can poke at.
      Against: it is the single largest change to the security posture in this
      file — an unauthenticated visitor who can start a container is an
      unauthenticated visitor spending this host's memory, which is exactly
      what §6 decision 13 and the embed's design refused. Do not build it
      before 13.2, which is the version of it that costs nothing.

- [ ] **13.2 A preview that does not need a container at all.**
      `grep -riE "sandpack|webcontainer|esbuild-wasm"` over `apps/` and
      `packages/` returns **0 hits**. Every preview in this product is a
      reverse proxy to a dev server inside Docker.

      What is missing is the other half of CodeSandbox's architecture: a
      browser-side bundler that resolves dependencies from a registry, builds
      in a worker, and renders in an iframe with no server-side process at all.
      It boots in about a second, survives being embedded ten thousand times on
      one page, and costs this host nothing — which is why CodeSandbox's embeds
      work at a scale this one's cannot.

      **Say plainly what it does not cover**, because this is the row most
      likely to be over-sold: it serves front-end projects with no server.
      `python-flask`, `python-fastapi`, `go-http`, `node-express` and every
      compose project (§11.3) are outside it forever. That is roughly half the
      template registry, and the half that is left is exactly the half people
      paste into issues.

      **Not the same as §3.3's process snapshots**, which resumes a *running
      container* and is blocked on a disk budget. This one replaces the
      container for a class of project, and is blocked on nothing.

      **For:** the reader of a shared link and the reader of an embed. If
      neither of those is a person this deployment has, this row has no user,
      and 13.1 has no cheap version — which is the honest reading of both.

- [ ] **13.3 Every pull request gets a URL.**
      The most valuable row in 13A for anybody working with other people, and
      the one whose mechanism is most nearly already here.

      Today `githubService.ts` and the `GithubConnection` model cover OAuth,
      listing repositories, import, and push with a token that
      `redactToken` keeps out of the output. There is no App, no webhook
      receiver, no per-branch workspace, and nothing that writes back to a pull
      request. `grep -rn "webhook"` in the GitHub path returns nothing
      (the only webhook in the tree is Stripe's, §8.4).

      What it needs: a GitHub App with `pull_request` and `push` events, a
      workspace created per head ref, the existing deploy path pointed at it,
      a comment posted back with the link, and teardown on merge or close.
      Four of those five exist — `repoImportService`, `deployService`,
      `releaseService` and the trash (§9.1) — and the fifth is a route.

      **It also supplies the trigger §12.2 says it is missing.** That row
      shipped prebuilds and states in its own text that what it lacks is a
      policy for *when*: "build on push, or build on a schedule, or build when
      a `devcontainer.json` changes". A pull-request event is the first of
      those three, arriving with a reason attached.

- [ ] **13.4 One repository, more than one workspace.**
      A `Project` is one directory and one row, and `switchBranch` changes the
      branch **in place** (`gitService.ts:475`). So reviewing a colleague's
      branch means stashing what you are doing (and §10.13 records that stash
      does not exist), or importing the repository a second time as an
      unrelated project with its own container, its own env vars and its own
      history.

      Adjacent to §10.14's multi-root and not the same: multi-root is several
      roots in one editor window, this is several checkouts of one repository
      that know they are related — sharing the account's credentials, the
      project's env vars, and one entry on the dashboard.

      **For:** anybody who reviews code. Cheap only if 13.3 exists, since the
      two want the same object.

- [ ] **13.5 Devtools for the thing being previewed.**
      The preview is an iframe pointed at a proxy, and that is all it is. A
      runtime `TypeError` in the previewed app appears in the *real* browser's
      console — which the embed's reader does not have open, and which on a
      tablet does not exist. There is no console capture, no network log, no
      error overlay, and no device-size frame.

      The problems panel is already built (`problems.ts`, `ProblemsPanel`) and
      §10.10 records that it is fed **only by the language server**, with the
      matcher half unbuilt. A runtime console is the third feed for that same
      panel, and unlike §10.10's problem matchers it needs no `tasks.json`
      first: it is a `postMessage` bridge injected into the preview document
      and a tab.

      **For:** everybody, and most sharply the person the preview is shared
      with, who cannot open devtools on somebody else's page and would not know
      to.

- [ ] **13.6 A pairing link for somebody with no account.**
      The collaborative layer is real and finished — Yjs per file, awareness,
      remote cursors, presence, follow mode — and reaching it requires being a
      row in `ProjectCollaborator`. An EDITOR share link exists
      (`shareRole`, `sharingController.ts:27`) and is still "a named grant":
      redeeming it creates the collaborator row against a `userId`, so the
      person on the other end signs up first.

      That is the correct default for a platform and the wrong one for ten
      minutes of pairing, which is the case the multiplayer layer is most
      obviously *for*. What it needs is a token that mints a scoped, expiring
      identity rather than an account — which is a thing this codebase already
      knows how to do twice (preview tokens and embed tokens are both typed,
      short-lived and checked on verify).

      **For:** the one use of the collaborative layer that does not require the
      other person to already be a user of this deployment. Note that §10.5
      lists the whole multiplayer layer as having no user at n=1 — if this
      deployment is one person, this row and everything it reaches is dead
      weight, and that is a reason to read §10.5 before starting rather than an
      argument with it.

---

### 13B. A personal VS Code that lives on a server

§10 answered "what stops one person using this instead of VS Code" as a
question about the editor and reached a route decision. §11 answered it about
the sandbox's posture. What is left after both is small, and it is not editor
parity: **it is the difference between a program on your laptop and a program
on a machine you are connected to.** A local editor never has to survive the
network, and every row below is something that only becomes a question because
the machine is somewhere else.

- [x] **13.7 A terminal that survives the laptop closing.** Shipped
      2026-09-09 — see §2.46. Original note follows.

      The sharpest row in this section, found the way §1 says the real ones are
      found — by reading two shipped things against each other — and the one
      that is most clearly a defect wearing a feature's clothes.

      `handleTerminalCreation.ts:166–176` registers `cleanup` on `ws.on("close")`
      and `ws.on("error")`, and `cleanup` calls `hangUpShell`, which SIGHUPs the
      shell by the pid in its pid file. So **closing the lid kills the build.**
      A dropped WebSocket, a train tunnel, a browser tab discarded by the OS,
      or a laptop asleep for thirty seconds ends `npm run build`, a migration,
      a long test run, or a `docker compose` pull, with no record and nothing
      to reattach to.

      **This code is right about the problem it was written for.** The comment
      above it is explicit: the stream "was previously never cleaned up on
      disconnect — and closing it turned out not to be enough on its own",
      because Docker keeps the pty open and the shell outlives its terminal.
      That is one of the three container defects found on 2026-09-04 by looking
      at a running container: an orphaned shell holding port 3000, and every
      closed terminal leaking a process against a `PidsLimit` of 256. The fix
      is load-bearing and must not be reverted.

      **And §11.7 gave the editor the exact opposite treatment**, in the same
      week: unsaved edits are kept across a lost connection and offered back
      rather than replayed, on the stated grounds that a dropped connection is
      an ordinary event and not a decision by the user. Two correct decisions,
      composing into a product where your **text** survives the tunnel and your
      **build** does not.

      The shape of an answer, and it is not "stop hanging up": a shell belongs
      to a *session* keyed by terminal id rather than to a socket, a
      disconnect detaches instead of hanging up, a reconnect within some window
      reattaches to the same pty with its scrollback, and the reaper hangs up
      on a **timer** — so the leak the 2026-09-04 fix closed stays closed, an
      hour later instead of instantly. `reclaimShells` already exists and
      already hangs up shells left over from earlier connections to a terminal
      id, which is half of this written for a different reason.

      **For:** anybody whose connection to this machine is a network, which at
      n=1 is the entire point of the machine. This is the row where "cloud"
      currently does less than a laptop, not more.

- [x] **13.8 A secret that belongs to the account, not to each project.**
      Shipped 2026-09-09 — see §2.48. Original note follows.
      `envVars` is a `Json` column on `Project` (`schema.prisma:877`), sealed
      by `secretBox` and injected into the container by `runEnv`. There is no
      other scope. One person with one `ANTHROPIC_API_KEY`, one `NPM_TOKEN`
      and one database URL types all three into every workspace they create,
      and rotating any of them means editing every project by hand.

      Cheap in a way few rows here are: the sealing, the injection path, the
      account screen and the audit trail all exist. What is missing is a second
      table, a merge order (project overrides account, and say so on the
      screen), and a decision about whether a *collaborator* on somebody's
      project gets the owner's account secrets — for which the answer is
      almost certainly no, and which is the only part of this that needs
      thinking about.

      **For:** every user of a personal deployment, from their second project
      onwards.

- [x] **13.9 A credential the sandbox itself can clone and push with.**
      **DECIDED and shipped 2026-09-09 — §2.51.** The decision is the first of
      the three options this row named: **agent forwarding over the Route C SSH
      channel**, which exists because §10.1 went to B + C the same day. The row
      predicted this: "the first is the only one that is not a secret sitting in
      a container, and it exists only if §10.1 goes to Route C."

      `AllowAgentForwarding yes`, and `AllowTcpForwarding` stays **no** — they
      are separate lines and the difference is the whole safety argument. TCP
      forwarding would be a tunnel out of a sandbox, straight through the egress
      gateway. Agent forwarding carries a socket the sandbox may ask to SIGN
      something; the private key never leaves the user's machine and cannot be
      read out of the socket. The `ssh` command the dialog hands over says `-A`,
      and says what it costs.

      **What it costs, in the row rather than in a footnote:** while somebody is
      connected, code running in the sandbox can USE their agent — for any
      repository that key opens, not only this one. That is true of agent
      forwarding everywhere it is used, it lasts exactly as long as the
      connection, and `SANDBOX_SSH_AGENT_FORWARDING=false` turns it off for
      anybody who would rather type a token.

      **What this deliberately does NOT fix, which is half of the row's own
      complaint.** The BROWSER terminal is `docker exec` and has no agent, so
      `git clone git@github.com:me/private` typed there still fails. The other
      two options would have fixed it and both are, in this row's own words, a
      secret sitting in a container that runs untrusted code — so the answer is
      "attach your editor, or use the server-side push that already exists",
      not a credential in the sandbox. Recorded as a limit that was chosen, not
      one that was missed.

      Original note follows.

      Blocked on a decision, and named so the decision gets made rather than
      arrived at.

      Three things in the tree look like this and none of them is: §11.9's
      `signingKey` is a *signing* key and is never offered for authentication;
      dotfiles are cloned with **no credential on purpose**, so a private
      dotfiles repository fails rather than working
      (`schema.prisma:179–180`); and `pushRemote` authenticates server-side
      with a token the sandbox never sees, which is why `redactToken` exists.

      Each of those is right. Together they mean `git clone
      git@github.com:me/private` typed into the terminal — the most ordinary
      thing a developer does on a new machine — fails, and so does `npm
      install` from a private registry, and so does anything a `Makefile` does
      over SSH.

      **The decision, stated once so it is not rediscovered:** any credential
      reachable from inside the sandbox is reachable by code running in the
      sandbox, which is untrusted by construction. The honest options are
      agent forwarding over the Route C SSH channel §11.1 spiked (the
      credential stays on the user's machine), a per-workspace deploy key with
      access to one repository, or a git credential helper that calls back to
      the server and is refused for anything but the project's own remote. The
      first is the only one that is not a secret sitting in a container, and it
      exists only if §10.1 goes to Route C.

- [ ] **13.10 The editor on a device that is not a laptop.**
      `useMediaQuery("(max-width: 900px)")` in `ProjectPlayground.tsx:255` is
      the whole of the mobile story: one breakpoint that collapses the layout.
      Monaco on a touch keyboard, a terminal with no `Ctrl`, and a file tree
      built for a mouse are all untested by anybody.

      **Kept because it is the only row in this section that Route C cannot
      reach** — §11.0 concedes in its own text that attaching your own editor
      "does nothing on an iPad", and a browser IDE's remaining advantage over
      SSH is precisely the device you cannot install VS Code on.

      **And it may well have no user here.** If nobody is going to edit code on
      a phone, this is a large piece of work for a device nobody uses, and §12's
      warning about this method applies to this row harder than to any other on
      the page. Listed, ranked last in 13B, and not recommended.

- [x] **13.11 A session that follows the person rather than the browser.**
      **Shipped 2026-09-09 — §2.49.** Four stores against the account through
      `GET`/`PUT /api/v1/account/session`, with `localStorage` kept as the local
      cache so first paint does not jump and a signed-out browser still has its
      settings. The row's own note below turned out to be right about where the
      work was — it is the same stores writing through an endpoint — and wrong
      about it being only that: the interesting part was the three rules that
      keep a pull from fighting the person using the machine, and a race in
      `useWorkspaceSession` that made the second-machine case depend on which
      of two round trips won. Original note follows.
      `editorSettingsStore` (sixteen preferences), `keybindingStore` (chord
      overrides), `openTabsStore`, `treeStructureStore` and the pane sizes all
      persist to `localStorage`. Open the same workspace from a second machine
      — which is the *reason* the workspace is on a server — and it is a blank
      editor with default settings and no open files.

      **Named separately from §10.9 on purpose**, because the two are one
      sentence apart and blocked on different things. §10.9 wants settings in
      *files*: committable, diffable, per-workspace, importable from a real VS
      Code profile — and it is behind §10.1, because under Route A it arrives
      free. This row wants the *session* — which tabs were open, where the
      splits were, what the tree had expanded — to live on the server against
      the account, and it is behind nothing at all: it is the same stores
      writing through an endpoint instead of to `localStorage`.

      **For:** anybody who uses this deployment from more than one machine,
      which is the population §10 was written for.

---

### Order, and what to do first if only one thing gets done

**Superseded for sequencing by §14**, which places these ten rows against §3,
§10, §11 and §12 rather than only against each other — and which splits them
between the two products they serve, since most of 13A has no user on a
personal deployment. What follows is this section's own order, kept because it
says *why* each row sits where it does.

~~**13.7, and it is not close.**~~ **Shipped 2026-09-09, the day this section
was written — §2.46.** The reasoning below held, including about where the work
was: half the mechanism really was already written, and the half that was not
turned out to be the four things that end a session rather than the detach
itself. **Next, now that it is done:** ~~13.8 on a personal deployment~~ — also done
(§2.48) — ~~so 13.11 on a personal deployment~~ — done too (§2.49) — so **13.3
on either**, which is the shared track's Phase 5a and the first row in this
section that a second person has to exist for. On a personal deployment the
next unblocked thing is not in §13 at all: it is §12.5, and it wants three
numbers somebody has to choose by watching a real host. Original note follows.

**13.7, and it is not close.** It is a defect in everything but name, its cost
is measured in somebody's lost build rather than in a missing feature, half its
mechanism (`reclaimShells`, the pid files) is already written, and it is the
one row on this page where this platform is currently *worse* than the laptop
it is asking to replace. Nothing here is blocked on §10.1 and this is blocked
on nothing.

Then, and the split is by which question the deployment is answering:

**If other people use it** — 13.3 (a URL per pull request, which also gives
§12.2 the trigger it says it lacks) → 13.5 (preview devtools, cheap, feeds a
panel that exists) → 13.2 (the container-free preview) → 13.1 (which 13.2 makes
affordable) → 13.6 → 13.4.

**If one person uses it** — ~~13.7~~ (done) → ~~13.8~~ (done)
→ ~~13.11~~ (done, §2.49) → 13.9 (credentials, once §10.1 is settled,
since Route C changes the answer) → and stop. 13.1 through 13.6 have no user
at n=1 for the reasons §10.5 already set out, and 13.10 probably has none
either.

**And one row already on this page moves up rather than in.** §3.3's backup and
restore is the only entry in this document that loses data rather than failing
to add a feature, and §10.5 already argued it stops being an acceptable written
trade-off at n=1. Nothing in §13 is more important than it. It is not repeated
as a row here because it is not a gap against either of these two products —
it is a gap against not losing your work.

### What was verified for this section

Checked against the tree on 2026-09-09, in the manner §5 requires. Every claim
below was run, not remembered.

- `grep -riE "sandpack|webcontainer|esbuild-wasm"` over `apps/` and
  `packages/` — **0 hits** (13.2).
- `grep -riE "launch\.json|tasks\.json|settings\.json|snippet|blame|stash|
  cherry-pick|createDiffEditor|timeline|multi-root|code-workspace|openvsx"`
  over the same, excluding `plan.md` — 0 hits for all of them, which is what
  §10.6–10.14 already say and is recorded here only because this section had
  to establish it was not repeating them.
- `handleTerminalCreation.ts:166–176` — `cleanup` is declared at `:166` and
  registered on `ws.on("close")` (`:175`) and `ws.on("error")` (`:176`); it
  calls `hangUpShell(container, pidFile)` at `:172`.
  `terminalShell.ts:137–146` SIGHUPs by the pid in that file, and
  `:149–159`'s `reclaimShells` already hangs up shells from earlier connections
  to the same terminal id (13.7).
- `schema.prisma:877` — `envVars Json @default("{}")` on `Project`, and no
  other env-var column anywhere in the schema; `projectEnvService.ts` exports
  `getEnvVars`, `setEnvVars` and `backfillSealedEnvVars`, all keyed by
  `projectId` (13.8).
- `schema.prisma:169–209` — `UserPersonalization` holds `dotfilesRepo`,
  `signingKey`, `signingKeyPublic` and `signCommits`, and `:179–180` says no
  credential is sent with the dotfiles clone "so a private repository fails
  rather than working" (13.9).
- `projectAccessService.ts:428–460` — `redeemShareToken` upserts a
  `ProjectCollaborator` row against a `userId`; `sharingController.ts:27`
  offers `VIEWER` or `EDITOR` and the comment above it says an EDITOR link "is
  still a named grant" (13.1, 13.6).
- `gitService.ts:475` — `switchBranch` operates on the project's single working
  tree (13.4).
- `ProjectPlayground.tsx:255` — one `useMediaQuery("(max-width: 900px)")`, and
  no other breakpoint or touch handling in the tree (13.10).
- `editorSettingsStore`, `keybindingStore`, `openTabsStore` and
  `treeStructureStore` all persist to `localStorage`; no endpoint reads or
  writes any of them (13.11). **No longer true as of §2.49** — and the detail
  this got slightly wrong is worth keeping: `openTabsStore` and
  `treeStructureStore` never persisted themselves, `workspaceStore` persisted
  on their behalf, which is why the fix is four stores rather than five.
- The GitHub path (`githubService.ts`, `githubController.ts`, `routes/v1/
  github.ts`) has no webhook receiver; the only webhook in the server is
  Stripe's, in `routes/v1/billing.ts` (13.3).

**Not verified, and it is the load-bearing one for 13.7:** nobody has closed a
laptop mid-build and watched what happens. The code path is unambiguous and the
comment above it says what it does, which is strong evidence and not the same
thing as having seen it — and §1's standing lesson is that the container layer
in particular has produced three defects nobody predicted from reading it.

---

## 14. The build plan

Written 2026-09-09, after §13.7 shipped, because the file had reached a state
it has not been in before: **twenty-eight open rows spread across six sections,
each written from a different angle, with no document saying what to build
next.** §4 is a per-item order and is now almost entirely struck through; §8
through §13 each end with an "Order" block that sequences *their own* rows
against each other and cannot see the others. Somebody arriving with "I want
this to be a personal cloud VS Code and a CodeSandbox" has to read six sections
and merge them by hand.

**This section adds no rows.** Every item below is an existing checkbox
somewhere above, referenced by its number. That is deliberate and it is the
first thing to check if this section ever seems to disagree with §1: a plan
that invented rows would double-count the work and §1's total would drift,
which is the exact failure §7's second paragraph exists to stop. §1 says 28
open; this section sequences those 28 and introduces nothing.

---

### 14.0 The observation that orders everything else

**These are two products, and the plan has to say so out loud.**

§13 already diffed against both and found they disagree about almost
everything. Put the two target definitions side by side and the disagreement
is not a matter of emphasis:

| | **Personal cloud VS Code** | **CodeSandbox** |
|---|---|---|
| Who opens it | one person, signed in, every day | a stranger, from a link, once |
| What a project costs | a container that can be warm all day | must be ~free, or the model does not work |
| What "fast" means | the editor keeps up with typing | the *first* paint, on a cold link |
| What the editor must do | debugging, extensions, tasks — VS Code | edit one file convincingly |
| Multiplayer | **no user** (§10.5) | the point |
| Auth | one account, or none | anonymous by default |

The rows that serve one mostly do nothing for the other. §10.5 already made
this argument in one direction and it holds in both: at n=1 the entire
CodeSandbox surface — the gallery, embeds, sharing, reports, moderation,
pairing — has no second person to serve. And a stranger following a link does
not want your dotfiles, your SSH key or your `settings.json`.

**So: pick a primary.** Not "eventually both" as a way of not choosing —
§10.1 is the standing lesson on what that costs, and it has held ten rows for
six days. The recommendation, and the reasoning is short:

> **Primary: the personal cloud VS Code. Secondary, and only after Phase 3:
> CodeSandbox.**

Because the distance is not comparable. For the personal target the platform is
**almost entirely built** — open a folder (§2.33), single-user mode (§2.34),
machine-sized limits (§2.35), per-workspace sizes (§2.38), devcontainers,
compose, dotfiles, 2FA, exposure, offline, notebooks, and as of today a
terminal that survives a dropped connection (§2.46). What is missing is one
architectural decision and a handful of days.

For the CodeSandbox target the missing thing is **an execution model this
repository does not have** (§13.2): every path into a working tree ends at a
Docker container, and a product whose embeds are pasted into a thousand pages
cannot start a container for each. That is not a feature, it is a second
runtime beside the first — and it is the right thing to build *second*, when
there is something to be second to.

If the answer is the other way round — if this is a product for other people
first — then Phases 4 to 6 move to the front and Phase 1 becomes optional. The
phases below are written so that reordering them that way is legible rather
than a rewrite.

---

### 14.1 Phase 0 — the decision, and it is still one afternoon

**§10.1, and nothing in Phases 1 or 3 should start before it.**

Ten of the twenty-eight open rows are behind this and it is not research: §6
decision 1, §10.0's recount, §11.0's argument and §11.1's spike have already
written down everything anybody needs. What is missing is somebody choosing.

**Recommendation: B + C — keep Monaco, and add Route C.** Not A. The argument,
compressed from §10.1 and §11.1:

- **Route B alone cannot be the answer.** Decision 1's closing sentence is that
  Monaco cannot run VS Code extensions at all, and a personal editor is largely
  defined by the six extensions its owner cannot work without. 10.7 is
  unreachable on B and no amount of work changes that.
- **Route A is now the expensive way to get there.** It delivers 10.6–10.14 at
  once, and charges the multiplayer layer, the run control and the preview as
  rewrites. §10.0 recounts that at n=1 and two of the four evaporate — but the
  two that survive are real work, and the multiplayer layer is the thing that
  makes this *not* just a VS Code you have to host yourself.
- **Route C reaches the two most expensive rows for 7 MB.** §11.1's spike is
  the strongest evidence in this file: the genuine VS Code server runs inside a
  sandbox under the full security posture, and `ms-python.python` installs from
  the marketplace bringing Pylance and debugpy with it. That is **10.6 and 10.7
  arriving as working software**, without giving up the editor this repository
  controls.
- **A and C are not exclusive, and neither are B and C.** Codespaces ships a
  browser editor and Remote-SSH. The browser editor stops having to be VS Code
  and gets to be what it is already good at — the thing you open on a machine
  you do not control, with multiplayer, the assistant, the run control and the
  preview in it.

**What choosing B + C does to the ten blocked rows.** 10.6 and 10.7 close by
being reachable over SSH rather than by being built. 10.8 through 10.14 stop
being blockers and become **browser-editor quality work** — still worth doing,
per Phase 3, but no longer the difference between usable and not. §3.3's
Debugging row closes with 10.6; note that it and 10.6 are **the same work
counted twice**, which is worth knowing when reading §1's total.

**If the answer is A instead**, Phase 1 becomes an openvscode-server migration,
Phase 3 disappears entirely, and Phases 4 to 6 are unaffected — they are
platform, not editor. Nothing below assumes B + C except Phase 1's shape and
the whole of Phase 3.

---

### 14.2 Phase 1 — one person can use this instead of VS Code

The phase that delivers the primary target. Everything in it is unblocked once
Phase 0 is settled, and two of the four are unblocked regardless.

**1a. ~~Settle where a backup goes, then build it (§3.3).~~ Shipped 2026-09-09
— §2.47.** The prediction below held exactly: the person-half was one question
answered in a sentence (the server does not choose the destination; it refuses
one on the same disk), and the code half was a job, a walk and a dump — plus a
restore, which turned out to be the larger half and the one that makes the
other real. Three defects found by running it, none of which any list
predicted. **What is still not done is the drill:** nobody has rebuilt a host
from it. Original note follows.

**1a. Settle where a backup goes, then build it (§3.3).** First, and ahead of
anything in this file that adds a feature, because it is **the only open row
that loses data rather than failing to add something**. §10.5 already argued it
stops being an acceptable written trade-off at n=1 and moves up; this is that
promotion being acted on.

Filed as blocked, and §9's method applies exactly: *which half needs a person
and which half is only code nobody wrote?* The person-half is one question —
a second disk, a bucket, or a documented acceptance — and for a personal
deployment it is a ten-minute answer, not an infrastructure programme. The
code half is a periodic job (the scheduler exists, §2.13), a tree walk and a
database dump. Note what does **not** solve it and is sometimes mistaken for
it: checkpoints are on the same disk as the thing they snapshot, and export is
a manual per-project zip.

~~**1b. Route C, properly (§10.1's third route, §11.1's spike).**~~ **Done
2026-09-09 — §2.50**, together with the §10.1 decision it was waiting on. The
`~/.vscode-server` volume this phase insisted must land *with* 1b did land with
it. Original note follows. The spike ran;
this is turning it into a feature. Four things, and the spike already named
three of them:

- `openssh-server` in the sandbox images and an authorised key the account
  owns — which is `UserPersonalization` extended, beside the signing key that
  is already there (§11.9).
- **A volume for `~/.vscode-server`.** Non-negotiable and the spike's sharpest
  finding: it reached 1.3 GB in the container's *writable layer*, which every
  environment-signature change and every `reconcileOnBoot` throws away. Without
  this, attaching re-downloads 229 MB and reinstalls every extension on each
  rebuild. One line, exactly as the package cache already does — but it has to
  be in the plan, not discovered afterwards.
- **Egress.** The spike ran on the default bridge with a published port, not
  behind the egress gateway, and that 229 MB marketplace download is the first
  thing a filtered sandbox refuses. Untested and load-bearing.
- **Drive a real client through it.** Nobody has run VS Code's Remote-SSH into
  this. The spike reproduced what that client does server-side, which is strong
  evidence and not the same thing.

**1c. ~~Account-scoped secrets (§13.8).~~ Shipped 2026-09-09 — §2.48.** The
estimate held: almost none of it was new code, and the one decision that had to
be taken — whether a collaborator sees the owner's account secrets — was
settled by saying it where the decision is made rather than by building
per-project opt-in lists. Original note follows.

**1c. Account-scoped secrets (§13.8).** The cheapest real row in the file with
a user on the other end. `envVars` is a Json column on `Project` and there is
no other scope, so one person with one `ANTHROPIC_API_KEY` types it into every
workspace and rotating it means editing each by hand. The sealing
(`secretBox`), the injection path, the account screen and the audit trail all
exist; what is missing is a second scope, a merge order (project overrides
account, and the screen says so), and one decision — whether a *collaborator*
on somebody's project sees the owner's account secrets, for which the answer is
almost certainly no.

~~**1d. A credential the sandbox can clone and push with (§13.9).**~~ **Done
2026-09-09 — §2.51**, and it took one config line: Phase 0 chose Route C, and
Route C is what makes agent forwarding exist. Original note follows. Blocked on a
decision, and **Phase 0 changes the answer**, which is why it is here and not
earlier: if the route includes C, agent forwarding over that SSH channel is
available and is the only option where the credential never sits inside a
container untrusted code is running in. Take it. If the route excludes C, the
choice narrows to a per-workspace deploy key or a credential helper that calls
back to the server, and both are secrets in a sandbox.

**What Phase 1 delivers:** one person opens a folder that is already on the
disk, attaches their own VS Code with their own extensions and a debugger,
gets their own secrets and their own git credentials in every workspace, and
does not lose it when the host dies — the last of which is done (§2.47), and
the rest of which is 1b to 1d.

---

### 14.3 Phase 2 — the machine stops surprising you

Small, unblocked, and each one closes a gap somebody hits in the first week.

~~**2a. A session that follows the person (§13.11).**~~ **Done 2026-09-09 —
§2.49.** It was the same stores writing through an endpoint, as this said. What
this did not say, and what took the time, is that a sync layer has to decide
what happens when the pull and the person disagree — three rules, each with a
test that fails without it. Explicitly not §10.9, which wants settings in
*files* and is Phase 3.

~~**2b. Prebuild a stopped workspace (§12.5).**~~ **Done 2026-09-09 — §2.52.**
The three numbers were chosen rather than measured, and are env vars documented
as guesses with the feature off by default — which is this phase's caution kept
rather than overridden. Original note follows. §2.39 shipped the running-
workspace half; this is the first open of a workspace that has been stopped all
week. Blocked on **three numbers somebody has to choose by watching a real
host** — how much headroom before a prebuild may run, how recently a workspace
must have been opened to be worth prebuilding, and whether to stop it
afterwards. Choosing them without having watched a host is how a background
task becomes the reason a machine is always busy, so this belongs *after*
Phase 1 has produced a host somebody is actually using.

~~**2c. Dev Container Features (§11.10).**~~ **Done 2026-09-10 — §2.53**, by
answering the question rather than waiting to live in a devcontainer daily. The
answer is the throwaway-root-container one, and it keeps §11.2's refusal
intact. Original note follows. A question with three answers, none
obviously right. Cheap to answer once somebody is living in a devcontainer
daily, which Phase 1 produces and nothing before it does.

---

### 14.4 Phase 3 — the browser editor stops being the second-class one

Only under B + C. Under Route A this phase does not exist — every row closes as
part of the migration.

The reframing Phase 0 buys: with debugging and extensions reachable over SSH,
none of these is the difference between usable and not. They are the difference
between a browser editor somebody tolerates and one they reach for. Ordered by
what a personal user notices soonest, which is §10's own recommended order with
10.6 and 10.7 struck out:

1. ~~**10.9 — settings, keybindings and snippets in files.**~~ **Done
   2026-09-10 — §2.54**, after 2a as this said, and the two do not disagree
   about the source of truth: workspace values are merged at the point of use
   and never written into the person's own store. Original note follows. §10 calls this the
   row that most decides whether the thing *feels* like a personal editor, and
   the cheapest of the nine. It also subsumes 2a's follow-the-person question
   for the settings half specifically, so do it after 2a rather than before, or
   the two will disagree about which is the source of truth.
2. ~~**10.13 — the rest of git.**~~ **Done 2026-09-10 — §2.55**, except rebase
   and the commit graph, which §2.55 names and explains. Stash and blame are the two a personal user
   notices in the first week; amend, revert, tags, cherry-pick and a graph
   after.
3. ~~**10.11 — a real diff editor.**~~ **Done 2026-09-10 — §2.56**, which also
   records that "createDiffEditor is unused" was true as a grep and wrong as a
   conclusion. Original note follows. `createDiffEditor` is unused. Compare with
   saved, compare two files, compare against a branch, and edit inside the
   diff.
4. ~~**10.10 — tasks**~~ **Done 2026-09-10 — §2.57.** Original note follows,
   including the sequencing with 13.5, which still holds: the panel now has two
   feeds and 13.5 is the third. **10.10 — tasks**, whose problem-matcher half has somewhere to go: the
   problems panel exists and is fed only by the language server. Sequence it
   with 13.5, which is the third feed for the same panel.
5. ~~**10.12 — local history and a timeline.**~~ **Done 2026-09-10 — §2.57b**,
   which found the premise half wrong: the checkpoints ARE per file and
   automatic, and only the reader was missing. Original note follows.
   Checkpoints are the wrong
   granularity for the question this answers.
6. ~~**10.8 — languages past Python and Go.**~~ **Done 2026-09-10 — §2.58**,
   and "one image per language" turned out to be wrong in a way worth keeping:
   TypeScript and JavaScript share one server in an image that already existed.
   Original note follows. One policy entry and one image per
   language. Note decision 2's revisit trigger fires here: the moment somebody
   wants rename or code actions, `lspClient.ts` is the seam that has to grow.
7. ~~**10.14 — the small ones.**~~ **Done 2026-09-10 — §2.59**, which found two
   of the six already shipped and carries two forward by name. Original note
   follows. §10's own caution applies hardest here: a week
   of daily use would probably promote one of these and it would be a surprise
   which.

---

### 14.5 Phase 4 — the cheap project, and the second product starts

**This is where the CodeSandbox target begins, and it begins with an
architectural addition rather than a feature.**

**4a. A preview that needs no container (§13.2).** A browser-side bundler that
resolves dependencies, builds in a worker and renders in an iframe with no
server-side process. It boots in about a second, survives being embedded on a
thousand pages, and costs this host nothing — which is why CodeSandbox's embeds
work at a scale this one's cannot.

Say plainly what it does not cover, because this is the row most likely to be
over-sold: it serves front-end projects with no server. `python-flask`,
`python-fastapi`, `go-http`, `node-express` and every compose project are
outside it permanently. That is about half the template registry, and it is the
half people paste into issues.

**4b. A sandbox a stranger can open, run and fork (§13.1).** Only after 4a,
which is what makes it affordable. Doing it first would mean an unauthenticated
visitor who can start a container — spending this host's memory with no account
behind it, which is exactly what §6 decision 13 and the embed's design refused
on purpose. With 4a there is a version that costs nothing and the refusal
stands.

This pair is the largest single body of work in the plan and it should be
costed as such before it is started.

---

### 14.6 Phase 5 — the git workflow other people can see

**5a. A URL per pull request (§13.3).** The most valuable row in §13 for
anybody working with other people, and four fifths of the mechanism exists —
`repoImportService`, `deployService`, `releaseService` and the trash. What is
missing is a GitHub App with `pull_request` and `push` events, a workspace per
head ref, a comment posted back, and teardown on merge. The GitHub path has no
webhook receiver today; the only webhook in the server is Stripe's.

**It also supplies the trigger §12.2 says in its own text that it lacks** — so
sequence it beside 2b rather than far from it, and the prebuild policy gets a
reason to fire instead of a schedule somebody guessed.

**5b. One repository, more than one workspace (§13.4).** `switchBranch` changes
the branch in place, so reviewing a colleague's branch means stashing (which
10.13 has only just added) or importing the repository twice as unrelated
projects. Cheap only once 5a exists, because the two want the same object.

---

### 14.7 Phase 6 — the preview, and the people

**6a. Devtools for the previewed app (§13.5).** Console capture, network log,
an error overlay, a device-size frame. A runtime `TypeError` appears only in
the real browser's console today — which the reader of an embed does not have
open and which on a tablet does not exist. A `postMessage` bridge and a tab,
feeding the problems panel that already exists.

**6b. A pairing link for somebody with no account (§13.6).** The multiplayer
layer is finished and reaching it requires being a row in
`ProjectCollaborator`. A token that mints a scoped, expiring identity rather
than an account — a thing this codebase already knows how to do twice, in
preview tokens and embed tokens.

**6c. Teams (§8.5).** Blocked on a pricing decision, and it turns every
`ownerId === userId` into a membership question. It belongs at the end of the
CodeSandbox track and nowhere in the personal one.

---

### 14.8 Not in the plan, and why

Recorded so nobody reads their absence as an oversight.

- **13.10 — the editor on a phone.** Ranked last in §13B, and §13B's own text
  says it may have no user. Large work for a device nobody here has been
  observed using. If somebody starts editing on a tablet, promote it; do not
  build it on the theory that they might.
- **12.4 — GPUs.** Blocked on hardware, not on anybody. An afternoon of
  `DeviceRequests` if the host has one and unstartable if it does not.
- **§3.3 autoscale.** A different product with a different cost model. §9.3's
  compute meter shipped the input its cost model was missing, which moves it
  closer without making it work anybody should start.
- **§3.3 process snapshots.** Genuinely blocked, on a disk budget and on a
  mechanism nothing here resembles. Not to be confused with 4a, which replaces
  the container for a class of project, or with 12.5, which produces a warm
  image.
- **§3.3 ACME for custom domains.** A deployment decision about where a private
  key lives. It gates HTTPS on verified custom domains and nothing else.

---

### 14.9 The dependencies, in one place

Everything that is *not* a straight line, so nothing below is discovered by
starting it in the wrong order:

- **Phase 0 gates** all of Phase 3, 1b, and 1d's answer. Nothing else.
- **1a (backup) gated nothing**, which was the argument for doing it first: it
  was the only row whose absence was measured in lost work rather than missing
  work. Done 2026-09-09 (§2.47), so Phase 1 now starts at 1b.
- **1b's volume for `~/.vscode-server` must land with 1b**, not after it. It is
  one line and the spike found it the expensive way.
- **2a before 10.9**, or the browser session and the settings file will
  disagree about which one is the source of truth. **2a landed 2026-09-09
  (§2.49)**, so 10.9 now arrives into a world that already answers "where does
  a setting live" — the account, through `/api/v1/account/session`, with
  `localStorage` as a cache under it. 10.9's job is to say how a *file* relates
  to that, not to invent a second answer.
- **4a before 4b.** Anonymous container starts are the thing that was refused
  on purpose; 4a is what makes the row affordable without reopening that.
- **5a beside 2b.** 5a produces the prebuild trigger 2b needs and 2b says it
  lacks.
- **5a before 5b.** Both want the same object — a workspace bound to a ref.
- **10.13 (stash) before 5b is comfortable**, since the workaround for one
  repository and two branches is the thing stash exists for.
- **6a with 10.10**, because they are the second and third feeds of one panel
  and the panel's shape should be decided once.

---

### 14.10 What this plan is not, and the standing caution

**It is not an estimate.** Nothing here carries a number of days, because this
file has no track record of estimating and inventing one would be the same
false precision §1 keeps stripping out of its own counts. What it carries is
*order* and *dependency*, which are the parts that are wrong in a way somebody
can notice.

**It is not a promise that these are the right rows.** §12's closing table
ranks the three methods this file has used and says the third — asking what a
category has — is the weakest and produces long lists cheaply. Ten of the
twenty-eight rows below came from it. The two things that would most change
this plan are both cheap and neither has been done: **use it as a daily editor
for a week** (§10 warned about this and it remains the largest untested claim
in the file), and **watch a real host under real use** (which 2b needs before
it can be started at all).

**And §4's lesson applies to this section too.** That section is a per-item
order, mostly struck through, and its most useful paragraph is the one saying
the work found by looking is roughly twice the work written down. A plan is a
statement about the work that is known. It has never once been the whole of it.

### What was verified for this section

A plan is mostly references to rows that were verified where they were written,
so this list is short by design — it covers only the claims §14 makes for the
first time or restates as a reason to sequence something. Checked against the
tree on 2026-09-09.

- **The row count.** `grep -c '^- \[ \]'` over this file returns **28**, and
  `grep -c '^- \[x\]'` returns **158**, both unchanged by this section — which
  is the property §14.0 claims and the one most likely to rot.
- **§3.3's Debugging and 10.6 are the same work in two rows.** §3.3's own text
  says "Revisit the route, not the row" and names §10.1 as what it is blocked
  on. Recorded rather than merged: a row belongs to its section, and §1's total
  should be read knowing it.
- **13.3.** `grep -rl webhook` over `routes/` and `controllers/` returns
  `billing.ts` and its test, and nothing else. The GitHub path has no receiver.
- **10.11.** `grep -rn createDiffEditor apps/web/src` — **0 hits**. Monaco's
  own side-by-side diff is unused.
- **10.13.** `grep -n 'stash\|blame' gitService.ts` — **0 hits**.
- **13.4.** `gitService.ts:475` — `switchBranch` operates on the project's
  single working tree.
- **13.8.** `envVars` appears **once** in the whole schema, on `Project`. There
  is no second scope.
- **13.11.** `editorSettingsStore`, `keybindingStore`, `workspaceStore` and
  `aiChatStore` all persist to `localStorage`; no endpoint reads or writes any
  of them. **Fixed 2026-09-09 (§2.49)** for the first three plus `themeStore`;
  `aiChatStore` is deliberately still local, being a conversation rather than a
  layout.

**Not verified, and it is the load-bearing one for the whole section:** the
ordering. Nobody has used this as a daily editor for a week, and §10 said when
it was written that such a week "would almost certainly reorder these rows —
most likely by promoting something in 10.14 that reads trivial here and is
intolerable in practice". That warning now applies to fourteen phases rather
than nine rows, and it is the single cheapest thing anybody could do to
falsify this plan.
