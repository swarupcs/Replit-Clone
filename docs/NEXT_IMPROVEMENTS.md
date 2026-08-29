# What is worth doing next

_Composed 2026-08-28, immediately after always-on deployments (`a59d8af`) and
public projects with forking (`9af71a3`) landed on `feat/deployments-and-forks`._

`IMPROVEMENTS.md` is the closed roadmap from 2026-08-22 and says so.
`docs/REPLIT_CLONE_PLAN.md` §8 sequences the product-level work and remains the
place to look for that. This file is narrower and shorter-lived: it records
what a survey of the codebase on this date actually found, including two
defects in work committed the same day.

Each item says what it is, why it matters, and where it lives. Nothing here is
a guess about the code — every claim below was checked against the source, and
where a claim could not be checked it says so.

---

## 1. Defects in what just shipped

These come first because they are not missing features. They are code that is
already merged and already wrong, and both are small.

### 1.1 A crashed deployment still reports "live"

`deploymentState` (`service/deployService.ts:231`) answers the editor's panel
by reading the `Deployment` row and nothing else. No path re-checks whether the
container behind a service deployment is still running: `serviceTarget` is
consulted only by the public origin at request time (`deploySite.ts`) and by
`restoreServices` at boot.

The published container is created with
`RestartPolicy: { Name: "on-failure", MaximumRetryCount: 10 }`
(`containers/deployContainer.ts:140`), so an app that keeps crashing is
restarted ten times and then stays dead. From that moment the public address
answers 503 and the owner's Deploy panel still says **live**, with a green dot,
indefinitely.

- **Why it matters:** this is not a missing feature, it is a feature that lies
  about its own state. The one person who could fix the app is the one person
  being told there is nothing wrong.
- **Where:** `deploymentState` should reconcile before answering — a
  `serviceTarget` call for `kind === "service"` rows, with the row moved off
  LIVE when nothing answers.
- **Alongside it:** `deployment.log` holds the tail captured *at publish time*
  and never changes afterwards. A service that has been up for a week shows the
  output of its first thirty seconds. `serviceLogs()` already exists and is
  already used on the failure path; the panel should read it on demand.

### 1.2 One user can occupy every always-on slot

`assertServiceBudget` (`containers/deployContainer.ts:160`) counts running
`rc-deploy-` containers host-wide and compares against
`MAX_DEPLOYED_SERVICES`. There is no per-user component, so a single account
publishing five services exhausts the host for everybody.

This is an asymmetry rather than an open design question: the same problem was
already solved for project containers by `assertUserContainerBudget`
(`containers/containerManager.ts:913`) reading `MAX_CONTAINERS_PER_USER`. The
deployment path simply never grew the equivalent.

- **Why it matters:** the host-wide cap exists so publishing cannot starve the
  editor. It does not stop one account starving every other account, which is
  reachable through entirely ordinary use — no malice required.

### 1.3 Public projects have no abuse story

Named here rather than implied, because it was a deliberate omission at the
time and should not be discovered later as a surprise.

There is no report mechanism, no review, and no rate limit on *publishing* (a
fork is rate limited, as project creation). A single-tenant or invite-only
deployment is unaffected. A public multi-tenant one needs all three before
`visibility = PUBLIC` is safe to expose, because a public project is a spam and
malware surface by construction.

---

## 2. Features that remain

### 2.1 Language servers beyond Python — the cheapest real win

`LANGUAGE_SERVERS` (`lsp/lspPolicy.ts:4`) has exactly one entry, `pylsp`. The
Go template gets syntax highlighting and nothing else: no diagnostics from the
real toolchain, no completion, no rename.

Everything underneath is built and shipped — the gateway with `Content-Length`
framing, the lazy start, the idle stop, and the memory policy that refuses a
server with a stated reason rather than letting the dev server be OOM-killed.
Adding `gopls` is a registry entry and an image that carries it.

- **Also newly true:** development's container default is now 2048 MB
  (`8522749`), which clears `LSP_MIN_CONTAINER_MEMORY_MB` on its own. A
  language server is eligible on a developer's machine as soon as
  `LSP_ENABLED` is set, which was not the case when that policy was written.

### 2.2 Custom domains for deployments

Blocked on infrastructure rather than on code: a deployment host needs a
wildcard DNS record and, over HTTPS, a wildcard certificate. Locally this costs
nothing, because browsers resolve every `*.localhost` name to loopback
themselves — which is exactly why the gap is invisible in development and
absolute in production.

### 2.3 Process snapshots

§8.2's remaining half, and the last thing CodeSandbox does that this does not.
`warmStart.ts` already skips a redundant install, so what is left is the dev
server process itself, which still dies with its container and boots again.
Resuming a running process is a mechanism nothing in this codebase resembles,
and it needs a decision about how much disk a suspended project may hold.

### 2.4 Autoscale and scheduled jobs

A different product with a different cost model. Always-on compute now exists
(`a59d8af`) in its smallest useful form — a long-lived container on this host —
and scaling it is a separate decision, not an extension of that work.

---

## 3. Debts worth clearing

- **`docs/REPLIT_CLONE_PLAN.md` §8.6 is stale.** It lists follow-mode
  (line 631) and checkpoint history (line 633) as missing. Both shipped in the
  parity plan's row 13: `service/checkpointService.ts` and the follow affordance
  in `PresenceStack.tsx`. A planning document that is wrong about what already
  exists is worse than no document, because it is read as authoritative.
- **`apps/web/src/config/monacoSetup.test.ts` asserts on source text**
  rather than on behaviour. It is the last item from the 2026-08-22 list never
  actioned, and the reason it matters was demonstrated twice on 2026-08-28: the
  nginx CSP bug and the `sh -lc` PATH bug were both invisible to source-reading
  checks and both caught only by running the real thing. It should be replaced
  by an assertion in `apps/web/e2e`.
- **Two `Project` rows have no working tree** ("P" and "site", created
  2026-08-27). Reported on 2026-08-28 and deliberately left alone: deleting rows
  and recreating trees are both judgment calls that belong to whoever owns the
  data, not to a cleanup script.
- **The `rc_test` database is undocumented.** It was created on 2026-08-28 so
  the DB-gated suites could run without touching development data, and it now
  gates ten test files through `TEST_DATABASE_URL`. `CONTRIBUTING.md` does not
  mention that it exists or how to make one, so the next person sees ten
  silently skipped files and no reason.

---

## Recommended order

1. **1.1 and 1.2 together.** Both are small, both are defects in code committed
   the same day, and 1.1 is the one a user actually hits.
2. **2.1 language servers.** The cheapest remaining feature, and unblocked.
3. **1.3 abuse handling**, before any deployment that is both public and
   multi-tenant. Not before that.
4. **3, the debts**, whenever they are cheaper than the confusion they cause.
   The stale §8.6 is the one that actively misleads.

Everything else in §2 is blocked on a decision or on infrastructure rather than
on work, and should not be started until that decision is made.
