# Contributing

Thanks for helping. This covers setup, the commands you'll use every day, and
the conventions the codebase actually holds itself to.

## Setup

Requirements: Node 22+, pnpm 10+, Docker, and Postgres (a compose file is
included).

```bash
pnpm install
pnpm images:build   # sandbox images — once, and whenever images/ changes
pnpm db:up          # Postgres on :15432
cp apps/server/.env.example apps/server/.env   # then fill the two JWT secrets
pnpm --filter '@replit-clone/server' exec prisma migrate deploy   # apply the schema
pnpm dev            # web on :15273, API on :3100
```

`pnpm dev` runs both in one terminal. To keep their output apart -- worth
it when you are watching the server's logs -- run one in each:

```bash
pnpm dev:server     # API on :3100, preview :3101, deploy sites :3102
pnpm dev:web        # :15273
```

Order does not matter; the web dev server proxies to the API and simply
fails those calls until it is up.

Or one command that does both, opening a second terminal for the web app and
keeping the server in the current one -- the server being the half whose logs
you came to read:

```bash
pnpm dev:split
```

The web terminal is independent: Ctrl+C here stops the server and leaves it
running, because a window that closes itself when an unrelated process stops
is worse than one you close yourself.

The web dev port is pinned and deliberate (see `apps/web/vite.config.ts`) —
CORS, the preview cookie, and frame-ancestors all key off the exact origin.

## Everyday commands

```bash
pnpm typecheck      # every package
pnpm lint           # every package
pnpm test           # unit + integration suites (server and web)
pnpm build          # shared first, then both apps in parallel
```

Server-only and web-only variants exist in each `apps/*/package.json`. The
interesting extras:

```bash
pnpm --filter '@replit-clone/server' exec vitest run src/service/searchService.test.ts
pnpm --filter '@replit-clone/web' e2e     # end-to-end, see below
```

CI runs typecheck, lint, test, and build on every push, in a job with a real
Postgres — so the DB-backed suites that skip on your laptop always run there.
A second job builds the sandbox images, and a third runs the **E2E suite**
against a stack it starts itself: Postgres, the API, the built web app, and a
real `sandbox-node` container. That job sets `E2E_REQUIRE=1`, which turns the
suite's usual "the stack is not up, skipping" into a hard failure — a run that
skips everything and reports green would claim the real stack was exercised
when nothing had been started.

## Tests

- **Server** tests are colocated (`*.test.ts` next to the file) and use
  Vitest + supertest. DB-backed suites skip themselves gracefully when
  `TEST_DATABASE_URL` is unset — a local run without Postgres is green, not
  red. That is roughly **129 tests you are not running**, so it is worth
  fifteen seconds to turn them on (below).
- **Web** tests live next to their stores/components; vitest only collects
  `src/**/*.test.*`, so the E2E specs are not picked up by accident.
- **E2E** (`apps/web/e2e/`) drives the real stack: your own `pnpm dev`, real
  Docker containers, no mocks. It skips with a note when the stack isn't up,
  and every run deletes the project it created so containers don't accumulate
  against the concurrency cap. Run it before touching anything in the seams
  it covers: save → container filesystem → dev server → preview.

### Running the DB-backed suites

Some suites exercise real rows rather than mocks — refresh-token rotation with
its unique hashes and replay detection, project access, the stored GitHub
connection. Those cannot be faithfully faked, so they skip unless you point
them at a database. They will not touch your development one: give them a
throwaway of their own.

With `pnpm db:up` already running, create it once and migrate it:

```bash
docker exec replit-clone-postgres psql -U replit -d postgres -c "CREATE DATABASE rc_test"
```

```bash
cd apps/server && DATABASE_URL="postgresql://replit:replit@localhost:15432/rc_test?schema=public" pnpm exec prisma migrate deploy
```

Then run the suite with the URL in the environment:

```bash
cd apps/server && TEST_DATABASE_URL="postgresql://replit:replit@localhost:15432/rc_test?schema=public" pnpm exec vitest run
```

It has to come from the **shell**, not from `.env`: `config/env.ts` skips
dotenv when `NODE_ENV=test` on purpose, so that your own `.env` — and the
development database in it — cannot leak into a suite that writes rows.

Without it: 1390 passing, 149 skipped. With it: **1519 passing, 20 skipped**
(the remainder are shell-quoting round-trips that need `/bin/bash`, so they
skip on Windows and run in CI). If your numbers look like the first pair, the
variable did not reach the runner.

When you fix a bug, the test that would have caught it goes in the same PR —
the race-condition fixes of the past few months all grew one.

## Conventions

- **`packages/shared` is the contract.** Socket events, REST shapes, and the
  file-tree types are declared once and imported by both apps. If you add or
  change an event, change it there — a renamed event should be a compile
  error, not a silent no-op.
- **One choke point per risk.** Paths resolve through `resolveInProject`,
  commands run as argv arrays, access checks state the level they need. Don't
  add a second way to do any of these; see `docs/SECURITY.md` for the full
  map and the reasoning.
- **Comments explain constraints, not mechanics.** The codebase comments the
  *why* of a non-obvious decision (and there are many, each of which was once
  a bug). Match that: a comment that narrates the next line is noise.
- **Errors carry codes.** Typed `AppError`s reach the client as
  `{ code, message }`; unexpected failures are logged server-side and
  flattened so host paths never leak.
- **Commit messages** follow the repo's style: `fix(server): …`,
  `feat: …`, `test(web): …` — scope optional when the change is cross-cutting,
  body in plain sentences explaining the *why*.

## Adding a template

Templates live in `apps/server/templates/<id>/` and are declared in
`src/templates/registry.ts` (start command, dev port, image). The start
command must bind `0.0.0.0` to be reachable through the preview proxy, and
anything it needs must exist in the base image — `pnpm images:build` after
changing `images/`.

## Reporting a security issue

Please don't open a public issue; see the reporting section in
`docs/SECURITY.md`.
