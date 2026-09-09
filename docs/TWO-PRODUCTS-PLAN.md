# Two products, one tree — an implementation plan

**Written 2026-09-09**, from a fresh reading of the whole tree against one
question: *what would it take to make this a CodeSandbox clone and a personal
cloud VS Code?*

## 0. How to read this, and what it is not

`plan.md` already asks this question. §13 diffs the tree against both products
and finds eleven rows; §14 sequences those rows against §3, §8, §10, §11 and
§12 into six phases. **This document does not replace either and does not
invent a single new goal.** It sits one level below them and supplies the thing
they deliberately do not carry: *the implementation*. Where §14 says "a
browser-side bundler that resolves dependencies, builds in a worker and renders
in an iframe", this says which package, which worker, which route, which
database column, and which test proves it works.

Three rules it inherits and keeps:

- **No new rows.** Every item here maps to a numbered row in `plan.md`. The
  mapping is stated on every heading, so `plan.md`'s open-row count stays the
  single source of truth.
- **Say who each thing is for.** `plan.md` §12 established that asking "what
  does the competitor have" produces long lists cheaply, and most of any
  ecosystem is unwanted. Every phase below names its user, and the ones whose
  honest answer is "possibly nobody on this deployment" say so.
- **Verified, not remembered.** §11 lists what was run against the tree today.

**One correction to `plan.md` on the way past.** §14's verification block
claims `grep -c '^- \[ \]'` returns 28 and the `[x]` form returns 158. Today
they return **25 and 161** — 13.7, 13.8 and 13.11 were checked off after that
block was written. The section is right about everything else; the count is the
thing §7 warns rots first.

---

## 1. What this tree actually is

Measured today, not recalled:

| | |
|---|---|
| Server | 127,409 lines of TypeScript across 17 directories |
| Web | 51,314 lines, React 19 + Vite 6, Monaco via `@monaco-editor/react` |
| Shared contracts | 3,083 lines, 24 modules, 109 socket events |
| Tests | 272 test files |
| Prisma models | 24 models, 12 enums |
| Templates | 13, in `apps/server/src/templates/registry.ts` |
| Sandbox images | 4 — node, python, go, egress |

The layers, outside in:

```
browser — React / Monaco / xterm
   |
   +— REST            /api/v1/*        Express, JWT, per-route access level
   +— socket.io                        editor, Yjs relay, AI, presence
   +— raw WebSocket                    terminal, LSP, notebook kernel
   +— reverse proxy   /preview/:id/*
                          |
              dockerode  —+
                          v
        one container per project, bind-mounting
        apps/server/projects/<id> at /home/sandbox/app
        512 MB · 0.5 CPU · 256 PIDs · caps dropped ·
        no-new-privileges · isolated bridge · egress gateway
```

Everything already built is a **platform**, and a good one. What is missing for
the two targets is not breadth — it is one architectural decision on the editor
side and one absent runtime on the sandbox side.

---

## 2. The two targets disagree, so the plan has two tracks

`plan.md` §14.0 sets this out and it survives re-derivation:

| | **Track P — personal cloud VS Code** | **Track S — CodeSandbox** |
|---|---|---|
| Who opens it | one signed-in person, daily | a stranger, from a link, once |
| Cost per project | a container warm all day is fine | must be near zero |
| "Fast" means | keystroke latency | first paint on a cold link |
| Editor must do | debug, extensions, tasks | edit one file convincingly |
| Multiplayer | no user at n=1 | the point |
| Auth | one account | anonymous by default |

**Recommendation stands: P is primary; S starts only after P3.** The reason is
distance, and it is measurable. For P the platform is built and the gap is one
decision plus a handful of days. For S the gap is *a second execution model
this repository does not contain* — `grep -riE
"sandpack|webcontainer|esbuild-wasm|@babel/standalone"` over `apps/` and
`packages/` returns **0 hits**, and every path into a working tree today ends at
a Postgres row, a host directory and a 512 MB container.

If this deployment is for other people first, invert: run Track S from S1 and
treat P1–P3 as optional. The tracks are written so that inversion is a
reordering rather than a rewrite.

---

## 3. Phase P0 — the decision (§10.1). One afternoon, and it gates ten rows

Ten open rows sit behind one unmade choice: **Monaco, or a real VS Code?**
Nothing in P1 or P3 should begin before it is written down.

**Recommendation: B + C.** Keep Monaco as the browser editor, and add SSH so a
real VS Code can attach. Not A (replace Monaco with openvscode-server).

- Route B alone cannot reach extensions. Monaco does not run VS Code
  extensions, at any budget. §10.7 is unreachable and stays unreachable.
- Route A delivers §10.6–10.14 at once but charges the multiplayer layer, the
  run control and the preview as rewrites — and the multiplayer layer is what
  makes this not merely a VS Code you have to host yourself.
- Route C reaches the two most expensive rows (10.6 debugging, 10.7
  extensions) for about 7 MB of image, because the genuine VS Code server runs
  *inside the existing sandbox under the existing security posture*. §11.1's
  spike already showed `ms-python.python` installing from the marketplace and
  bringing Pylance and debugpy with it.
- A and C are not exclusive, and neither are B and C. Codespaces ships both a
  browser editor and Remote-SSH.

**What choosing B+C does:** 10.6 and 10.7 close by becoming *reachable* rather
than by being built. 10.8–10.14 stop being blockers and become browser-editor
quality work (P3). §3.3's "Debugging" row closes with 10.6 — they are the same
work counted in two places, which is worth knowing when reading §1's total.

**Deliverable of P0:** one paragraph appended to `plan.md` §6 as a numbered
decision, with the date. Nothing else. If the answer is A instead, P1 becomes an
openvscode-server migration, P3 disappears, and Track S is unaffected.

---

## 4. Track P — the personal cloud VS Code

### P1 — attach your own editor (§10.1 Route C, §13.9)

The phase that delivers the primary target. Six pieces, and the spike already
found the expensive one.

**P1.1 — `sshd` in the sandbox images.**
Files: `images/{node,python,go}/Dockerfile`.

Add `openssh-server`. The images already install `openssh-client` for git's SSH
signing backend, so this is the server half of a package family that is present.
Key-only auth, no password, no root, listening on 2222 inside the container.

The trap: host keys. Generate them into `/home/sandbox/.cache/ssh`, not
`/etc/ssh`. The cache path is already a volume; `/etc/ssh` is in the writable
layer, so every rebuild would regenerate them and every client would see a
host-key-changed warning. The same bind-mount-decides-the-uid rule that shaped
these images applies — nothing may assume uid 1001.

**P1.2 — an authorised key the account owns.**

Schema delta on `UserPersonalization`, which exists for exactly this ("things
that follow the person into every container"):

```prisma
/// Public keys this account may attach an editor with. Public halves only:
/// the private key never leaves the user's machine, which is the whole
/// argument for this route over a credential stored in a container.
sshAuthorizedKeys Json @default("[]")
```

Note the asymmetry with its neighbours and keep it: `signingKey` is sealed and
never returned by the API; these are public halves stored in the clear, safe to
show. `lib/sshKey.ts` already parses and validates OpenSSH key material — reuse
it rather than writing a second parser.

Injection at the same place dotfiles land: `containers/dotfiles.ts` already runs
per container start and writes into `$HOME`. Write
`~/.ssh/authorized_keys`, mode 0600, from the account's list.

Surface: `PUT /api/v1/account/personalization` exists
(`personalizationController.ts`); add the field to its zod schema and to
`toPersonalization`. Web: `AccountDialog/Identity.tsx` already renders the
signing key — put the key list beside it.

**P1.3 — a volume for `~/.vscode-server`. Lands *with* P1.2, not after.**

The spike's sharpest and most expensive finding: VS Code's server reaches
**1.3 GB in the container's writable layer**, which every environment-signature
change and every `reconcileOnBoot` throws away. Without a volume, each attach
re-downloads about 229 MB and reinstalls every extension.

File: `containers/containerManager.ts`, beside the existing package-cache
volume. One named volume **per user**, not per project — per user is both
cheaper and the point of "personal". Mount at `/home/sandbox/.vscode-server`.

State the budget consequence before somebody hits it: 1.3 GB per user that
`diskUsageService` does not count today. Count it or exclude it deliberately.
Silently uncounted is how a quota becomes a lie.

**P1.4 — routing SSH in. The one genuinely new mechanism.**

Nothing is published to the host today; the preview reaches containers by
container IP or a loopback publish (`PREVIEW_TARGET_MODE`). SSH needs the same
question answered and cannot reuse the HTTP proxy, because it is not HTTP.

Two options; take the first:

1. **One SSH endpoint on the server, multiplexed by username.**
   `ssh <projectId>@host -p 2222`. The server terminates the connection,
   authenticates against `sshAuthorizedKeys`, resolves the project, checks
   access through the *existing* `assertProjectAccess`, and pipes into a
   `docker exec` — which is the exact shape `terminal/terminalGateway.ts`
   already has, with a different transport in front. One port, one auth path,
   the access model unchanged.
2. Publish 2222 per container on loopback with a real bastion in front. Fewer
   lines, but it moves authentication outside the code that owns it.

New files: `apps/server/src/ssh/sshGateway.ts` and `sshPolicy.ts`, mirroring
`lsp/lspGateway.ts` + `lspPolicy.ts` — read those first, they are the closest
existing analogue and they already solve the "authenticate a raw stream against
a project" problem. Config: `SSH_ENABLED` defaulting **off**, `SSH_PORT`, like
every other capability that widens the attack surface.

**P1.5 — egress. Untested and load-bearing.**

The spike ran on the default bridge with a published port, *not* behind the
egress gateway. The first thing VS Code's server does is download 229 MB from
the marketplace; the first thing a filtered sandbox does is refuse it. Add
`update.code.visualstudio.com`, `marketplace.visualstudio.com` and
`*.vsassets.io` to the policy in `packages/shared/src/network.ts` — and note
that `pnpm images:prepare` compiles that module into the egress image, so this
is a rebuild, not a restart.

**P1.6 — a credential the sandbox can clone and push with (§13.9).**
P0 changes the answer, which is why this sits here. **With Route C, take agent
forwarding**: the credential stays on the user's machine, and nothing secret
sits in a container running untrusted code — which is the objection that has
blocked this row. Enable `AllowAgentForwarding` in P1.1's sshd config.

Then say the asymmetry out loud on the screen: `git clone git@github.com:...`
works from an SSH session and not from the browser terminal. That is a real
limitation with a real reason, and a user who is told it will not file it as a
bug.

**Acceptance for P1 — and it is not "the code compiles":**

- A real VS Code on a real laptop connects via Remote-SSH to a project.
- `ms-python.python` installs from the marketplace *through the egress gateway*.
- A breakpoint in a Flask route is hit and stepped.
- The container is rebuilt (change an env var to force a signature change) and
  the extension is still installed.
- `git clone` of a private repository succeeds inside the SSH session via a
  forwarded agent.
- `SSH_ENABLED=false` leaves no listener and no open port.

Nobody has driven a real client through any of this. §1's standing lesson is
that the container layer has produced three defects nobody predicted from
reading it.

### P2 — the machine stops surprising you

**P2.1 — prebuild a stopped workspace (§12.5).** `containers/prebuild.ts` and
§2.39 shipped the running-workspace half; this is the first open of a workspace
stopped all week. **Blocked on three numbers a person must choose by watching a
real host**: how much headroom before a prebuild may run, how recently a
workspace must have been opened to be worth prebuilding, and whether to stop it
afterwards. Guessing them is how a background task becomes the reason the
machine is always busy. Do it *after* P1 has produced a host somebody uses.

**P2.2 — Dev Container Features (§11.10).** Three possible answers, none
obviously right, and cheap to settle once somebody lives in a devcontainer
daily — which P1 produces and nothing before it does.

### P3 — the browser editor stops being second-class (§10.8–10.14)

Only under B+C. Under Route A this phase does not exist.

With debugging and extensions reachable over SSH, none of these decides
usable-or-not; they decide tolerated-or-reached-for. In the order a personal
user notices them:

1. **10.9 — settings, keybindings and snippets in files.** Do it *after*
   §13.11 (shipped), not before, or the browser session and the settings file
   will disagree about the source of truth. §13.11 already answered "where does
   a setting live" — the account, through `GET`/`PUT /api/v1/account/session`,
   with `localStorage` as a cache underneath. 10.9's job is to say how a
   committed `.vscode/settings.json` *relates* to that, not to invent a second
   answer. Suggested rule, written down once: file wins for anything a
   repository can reasonably own (formatting, tab width, exclude globs);
   account wins for anything about the person (theme, keymap, font).
2. **10.13 — the rest of git.** `grep -n 'stash\|blame'
   apps/server/src/service/gitService.ts` returns **0**. Stash and blame are
   what a personal user misses in week one; amend, revert, tags, cherry-pick and
   a graph after. `gitService.ts` already exports 28 functions in a consistent
   shape — these are additions to a working pattern, not new architecture.
3. **10.11 — a real diff editor.** `grep -rn createDiffEditor apps/web/src`
   returns **0**: Monaco's own side-by-side diff sits unused while
   `parseUnifiedDiff` + `DiffView` render diffs by hand. Compare-with-saved,
   compare-two-files, compare-against-branch, and editing inside the diff.
4. **10.10 — tasks.** One run command per project today. The problem-matcher
   half has somewhere to go: `ProblemsPanel` exists and is fed only by the
   language server. **Sequence this with S4.1**, which is the third feed for the
   same panel — decide the panel's shape once, not twice.
5. **10.12 — local history and a timeline.** Checkpoints are the wrong
   granularity for the question this answers.
6. **10.8 — languages past Python and Go.** `lsp/lspPolicy.ts` knows exactly
   two servers. Each new one is a policy entry plus an image layer. Decision 2's
   revisit trigger fires here: the moment somebody wants rename or code actions,
   `lspClient.ts` is the seam that has to grow.
7. **10.14 — the small ones.** §10's caution bites hardest here: a week of
   daily use would probably promote one of these, and it would be a surprise
   which.

---

## 5. Track S — CodeSandbox

### S1 — a preview that needs no container (§13.2)

**This is an architectural addition, not a feature, and it is the largest single
body of work in either track. Cost it before starting it.**

Today every preview is a reverse proxy to a dev server inside Docker. What is
missing is the other half of CodeSandbox's architecture: a browser-side bundler
that resolves dependencies from a registry, builds in a worker, and renders in
an iframe with **no server-side process at all**. It boots in about a second,
survives being embedded ten thousand times on one page, and costs this host
nothing — which is why CodeSandbox's embeds work at a scale this one's cannot.

**Say plainly what it does not cover**, because this is the row most likely to
be over-sold. It serves front-end projects with no server. Of the 13 templates:
`react-vite`, `react-vite-ts`, `vue-vite`, `svelte-vite` and `static-html` are
in scope — five. `node-express`, `node-express-ts`, `node-express-postgres`,
`nextjs`, `nextjs-ts`, `python-flask`, `python-fastapi`, `go-http` and every
compose project are outside it permanently — eight. That is roughly half the
registry, and the half in scope is exactly the half people paste into issues.

**Build vs. adopt.** Three honest options:

| | Cost | Risk |
|---|---|---|
| Adopt Sandpack (`@codesandbox/sandpack-client` + the public bundler) | days | a third-party bundler service in the request path; the thing you are cloning becomes a dependency |
| Self-host Sandpack's bundler | ~a week | a second deployable, but no external dependency |
| Build on `esbuild-wasm` + a CDN resolver (esm.sh / jsDelivr) | weeks | full control, and you own every module-resolution edge case forever |

**Recommendation: adopt Sandpack's client, self-hosted bundler, behind a
capability flag.** It is the only option that gets a working product without
either an external dependency in the hot path or a module resolver written from
scratch. Revisit if the bundler's licence or maintenance becomes a problem.

**Where it plugs in.** The seam already exists and is small:

- `templates/registry.ts` gains one field:
  ```ts
  /** How this template can be previewed with no container at all (§13.2).
   *  Absent is the honest answer for anything that needs a process at
   *  request time — Express, Flask, FastAPI, Go, and every compose project. */
  browserPreview?: { entry: string; environment: "vite-react" | "vite-vue" | "vite-svelte" | "static" };
  ```
  The same shape as the existing `staticBuild` / `serviceDeploy` pair, and a
  test should hold that a template declaring `browserPreview` is one whose
  `image` is the node image.
- `apps/web/src/components/organisms/BrowserPreview/` — new. It reads the file
  tree from the existing REST surface, mounts the bundler client, and renders
  the iframe. It does **not** touch the run control.
- `ProjectPlayground.tsx` chooses between `BrowserPreview` and the existing
  proxy preview based on the template's `browserPreview` and whether a container
  is running. Container preview stays authoritative when one is up: a person who
  pressed Run wants their dev server, not a re-bundle.
- Nothing on the server changes for the *rendering* path. That is the point.

**Acceptance:** a React project renders in the browser preview with no container
started, verified by asserting no container exists for that project id.
A `python-flask` project offers no browser preview and says why.

### S2 — a sandbox a stranger can open, run and fork (§13.1)

**Only after S1**, and the ordering is a security decision rather than a
convenience. An unauthenticated visitor who can start a container is an
unauthenticated visitor spending this host's memory, which is exactly what §6
decision 13 and the embed's design refused on purpose. S1 supplies a version
that costs nothing, so the refusal can stand.

Design, and it reuses two mechanisms this codebase already has twice:

- **Anonymous read + edit, in the browser, with no persistence.** The visitor
  gets the file tree from a public project, edits in Monaco, and sees S1's
  browser preview rebuild. Nothing is written server-side, so there is no quota
  to spend and no row to create. This is the whole of the "open and run" half.
- **Fork requires an account, and that is correct.** The moment edits must
  survive, there is a directory and a row, and those belong to somebody. Keep
  the sign-up wall exactly here and nowhere earlier.
- Extend the embed rather than the project router. `routes/v1/embeds.ts` is
  already the one surface that answers with a project's source and no session
  behind it, and `embedService.ts` already derives what is listed and what is
  served from one function — which is the property that stops a path being
  hidden from the listing but readable by asking.

Schema: `Embed` gains `allowEdit Boolean @default(false)`. That is the whole
delta, because the editing happens in the reader's browser.

**Who this is for:** the reader of a shared link and the reader of an embed. If
neither of those is a person this deployment has, S1 and S2 have no user, and
§10.5's argument about the whole multiplayer surface applies to them too.

### S3 — a URL per pull request (§13.3)

**The most valuable row in Track S for anybody working with other people, and
four-fifths of the mechanism already exists.** `repoImportService`,
`deployService`, `releaseService` and the trash (§9.1) are all built.
`grep -rl webhook` over `routes/` and `controllers/` returns `billing.ts` and
its test, and nothing else — the GitHub path has no receiver.

What is missing:

1. A **GitHub App** (not the existing OAuth app) subscribed to `pull_request`
   and `push`. New: `service/githubAppService.ts` beside `githubService.ts`.
2. A webhook receiver at `POST /api/v1/github/webhook`, signature-verified.
   `service/stripeSignature.ts` is the existing pattern for HMAC-verifying a
   webhook body before parsing it — copy its shape, including reading the raw
   body.
3. A workspace per head ref. This is §13.4's object (see S5) and the two want
   the same thing, which is why they are sequenced together.
4. The existing deploy path pointed at that workspace, and a comment posted back
   with the link.
5. Teardown on merge or close, into the existing trash rather than a hard
   delete.

**It also supplies the trigger P2.1 says in its own text that it lacks.** A
pull-request event is a prebuild reason arriving with a cause attached, instead
of a schedule somebody guessed. Sequence S3 near P2.1.

### S4 — the preview, and the people

**S4.1 — devtools for the previewed app (§13.5).** The preview is an iframe
pointed at a proxy and nothing else. A runtime `TypeError` in the previewed app
appears in the *real* browser's console — which the reader of an embed does not
have open, and which on a tablet does not exist. There is no console capture, no
network log, no error overlay and no device-size frame.

Mechanism: a `postMessage` bridge injected into the preview document, plus a
tab. `routes/preview.ts` does not rewrite HTML today — the injection point has
to be added, and it must be `Content-Type`-gated to `text/html` and skipped for
everything else. Under S1's browser preview the injection is free, because the
iframe is already ours.

Feed it into `ProblemsPanel`, which exists and is currently fed only by the
language server. **This is the third feed for that panel and P3's tasks row is
the second — decide the panel's shape once.**

**S4.2 — a pairing link for somebody with no account (§13.6).** The
collaborative layer is finished — Yjs per file, awareness, remote cursors,
presence, follow mode — and reaching it means being a row in
`ProjectCollaborator`, which needs a `userId`
(`projectAccessService.ts:428–460`). An EDITOR share link exists and is still a
named grant: redeeming it creates the row, so the person on the other end signs
up first.

What it needs is a token that mints a **scoped, expiring identity** rather than
an account — a thing this codebase already does twice, in preview tokens and
embed tokens, both typed and checked on verify. Same `tokenService` pattern, a
new type, and an ephemeral collaborator that `assertProjectAccess` understands.

**S4.3 — teams (§8.5).** Blocked on a pricing decision, and it turns every
`ownerId === userId` comparison into a membership question. It belongs at the
end of Track S and nowhere in Track P.

### S5 — one repository, more than one workspace (§13.4)

`gitService.ts:475` — `switchBranch` changes the branch **in place** on the
project's single working tree. So reviewing a colleague's branch means stashing
(which P3.2 has only just added) or importing the repository a second time as an
unrelated project with its own container, its own env vars and its own history.

Not the same as §10.14's multi-root: that is several roots in one editor window;
this is several checkouts of one repository that *know they are related* —
sharing the account's credentials, the project's env vars, and one dashboard
entry.

Schema sketch:

```prisma
/// Sibling checkouts of one repository. The parent owns credentials, env vars
/// and the dashboard entry; each child owns a ref, a directory and a container.
parentWorkspaceId String?
parentWorkspace   Project?  @relation("Workspaces", fields: [parentWorkspaceId], references: [id], onDelete: Cascade)
workspaces        Project[] @relation("Workspaces")
gitRef            String?
```

Cheap only once S3 exists, because the two want the same object. **P3.2 (stash)
before this is comfortable**, since the workaround for one repository and two
branches is precisely the thing stash exists for.

---

## 6. Everything that changes the database, in one place

Kept together so a migration is planned rather than discovered:

| Phase | Model | Change |
|---|---|---|
| P1.2 | `UserPersonalization` | `sshAuthorizedKeys Json @default("[]")` |
| S1 | — | none (registry field only, not a column) |
| S2 | `Embed` | `allowEdit Boolean @default(false)` |
| S3 | new `GithubAppInstallation` | installation id, account, repo allowlist |
| S3/S5 | `Project` | `parentWorkspaceId`, `gitRef` |
| S4.2 | — | none; an ephemeral identity is a token, not a row |
| S4.3 | new `Team`, `TeamMember` | and every `ownerId` check becomes a membership check |

Four of the seven phases need no migration at all, which is the strongest single
signal that this plan is mostly wiring existing parts together.

---

## 7. The dependency graph

Everything that is not a straight line:

- **P0 gates** all of P3, P1.4 and P1.6's answer. Nothing else.
- **P1.3 (the vscode-server volume) must land with P1.2**, not after. It is one
  line and the spike found it the expensive way.
- **P1.5 (egress) before P1's acceptance run**, or the marketplace download
  fails and the failure looks like an sshd problem.
- **§13.11 before P3.1**, and §13.11 is done — so 10.9 arrives into a world that
  already answers "where does a setting live".
- **S1 before S2.** Anonymous container starts were refused on purpose; S1 is
  what makes S2 affordable without reopening that.
- **S3 beside P2.1.** S3 produces the prebuild trigger P2.1 says it lacks.
- **S3 before S5.** Both want the same object — a workspace bound to a ref.
- **P3.2 (stash) before S5 is comfortable.**
- **S4.1 with P3.4**, because they are the second and third feeds of one panel.

---

## 8. Recommended order, if only a few things get done

**One thing:** P0. It is an afternoon, it unblocks ten rows, and it has been
open for a week while everything downstream waits.

**A week:** P0 → P1.1–P1.5. At the end of it, one person opens a folder already
on the disk, attaches their own VS Code with their own extensions and a
debugger, and keeps them across a rebuild. That is the primary target
delivered.

**A month:** add P1.6, P2, and P3.1–P3.3. The browser editor stops being the
one you tolerate.

**After that, and only then:** S1. It is the largest body of work in either
track and it starts a second product; it deserves to be started when there is
something for it to be second to.

---

## 9. What is deliberately not here

Recorded so nobody reads the absence as an oversight. These match `plan.md`
§14.8:

- **§13.10 — the editor on a phone.** One `useMediaQuery("(max-width: 900px)")`
  in `ProjectPlayground.tsx:255` is the whole mobile story. Large work for a
  device nobody here has been observed using. Promote it if somebody starts
  editing on a tablet; do not build it on the theory that they might.
- **§12.4 — GPUs.** An afternoon of `DeviceRequests` if the host has one, and
  unstartable if it does not. Blocked on hardware, not on anybody.
- **§3.3 autoscale.** A different product with a different cost model.
- **§3.3 process snapshots.** Genuinely blocked, on a disk budget and on a
  mechanism nothing here resembles. Not to be confused with S1, which replaces
  the container for a class of project, or with P2.1, which produces a warm
  image.
- **§3.3 ACME for custom domains.** A deployment decision about where a private
  key lives. It gates HTTPS on verified custom domains and nothing else.

---

## 10. Risks, and the two cheapest ways to falsify this plan

**The ordering is the load-bearing untested claim.** Nobody has used this as a
daily editor for a week, and §10 predicted when it was written that such a week
"would almost certainly reorder these rows — most likely by promoting something
in 10.14 that reads trivial here and is intolerable in practice". That warning
now applies to nine phases rather than nine rows.

The two things that would most change this plan are both cheap and neither has
been done:

1. **Use it as a daily editor for a week.** It would reorder P3 and probably
   promote something out of 10.14.
2. **Watch a real host under real use.** P2.1 cannot be started without the
   three numbers this produces.

Specific risks, each with the phase it lands in:

- **P1.4 — the SSH gateway is new transport code in front of `docker exec`.**
  The closest analogue (`lspGateway`) is 237 lines, which is encouraging; the
  authentication is the part to review hardest, because it is the first place a
  raw TCP stream reaches the access model.
- **P1.5 — egress is untested for the marketplace.** It is the likeliest cause
  of P1 appearing to work in dev and failing on a real deployment.
- **P1.3 — 1.3 GB per user of uncounted disk.** Quota lies are found late.
- **S1 — the "half the templates" boundary will be discovered by a user, not by
  a document,** unless the UI says which projects can and cannot use the browser
  preview and why. Put the sentence on the screen.
- **S2 — anonymous editing widens the read surface even though it writes
  nothing.** The embed's existing property — one function deriving both what is
  listed and what is served — must survive the change, or a file hidden from the
  listing becomes readable by asking for it.
- **S3 — a GitHub App is a second credential model** beside the OAuth
  connection that already exists. Two token paths that can drift is exactly the
  shape of defect this tree has produced before.

**And the standing caution.** `plan.md` §4's most useful sentence is that the
work found by looking is roughly twice the work written down. This is a plan.
It has never once been the whole of it.

---

## 11. What was verified for this document

Run against the tree on 2026-09-09, not remembered:

- `grep -riE "sandpack|webcontainer|esbuild-wasm|@babel/standalone"` over
  `apps/` and `packages/` — **0 hits** (S1).
- `grep -rl webhook` over `apps/server/src/routes` and `controllers` —
  `billing.ts` and its test, nothing else (S3).
- `grep -rn createDiffEditor apps/web/src` — **0 hits** (P3.3).
- `grep -n 'stash\|blame' apps/server/src/service/gitService.ts` — **0 hits**
  (P3.2).
- `grep -riln "breakpoint|debugAdapter|debugpy"` across server, web and shared —
  5 files, all of them `plan.md`-adjacent prose or test fixtures; no debug
  adapter exists (P0, 10.6).
- `grep -riE "openvscode|code-server|vscode-server|openssh|sshd|remote-ssh"` —
  hits only in `lib/sshKey.ts`, `personalizationService.ts`, their tests, the
  account UI, and the three Dockerfiles' `openssh-client` line. **No SSH server
  and no VS Code server anywhere in the tree** (P1).
- `apps/server/prisma/schema.prisma` — 24 models, 12 enums; `envVars` appears on
  `Project` and on `UserPersonalization` (§13.8 shipped) and nowhere else;
  `UserEditorState` exists with `key`/`value`/`rev` (§13.11 shipped).
- `apps/server/src/terminal/terminalSessions.ts` — sessions carry `scrollback`,
  `detachedAt` and `reattachable`; a disconnect detaches and only a timer hangs
  up (§13.7 shipped, and the mechanism is as §14 describes it).
- `templates/registry.ts` — 13 templates; each declares `image`, `devPort`,
  `startCommand`, and exactly one of `staticBuild` / `serviceDeploy`.
- `lsp/lspPolicy.ts` — `LANGUAGE_SERVERS` holds exactly two entries, python and
  go (P3.6).
- `grep -c '^- \[ \]' plan.md` — **25**; the `[x]` form — **161**. §14's
  verification block says 28 and 158.

**Not verified, and it is the load-bearing one:** nobody has attached a real VS
Code over Remote-SSH to a container from this tree. §11.1's spike reproduced
what that client does server-side, which is strong evidence and not the same
thing as having seen it work.
