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

CI runs typecheck, lint, test, and build on every push; it does not run the
E2E suite (that needs Docker and the sandbox images).

## Tests

- **Server** tests are colocated (`*.test.ts` next to the file) and use
  Vitest + supertest. DB-backed suites skip themselves gracefully when
  `TEST_DATABASE_URL` is unset — a local run without Postgres is green, not
  red.
- **Web** tests live next to their stores/components; vitest only collects
  `src/**/*.test.*`, so the E2E specs are not picked up by accident.
- **E2E** (`apps/web/e2e/`) drives the real stack: your own `pnpm dev`, real
  Docker containers, no mocks. It skips with a note when the stack isn't up,
  and every run deletes the project it created so containers don't accumulate
  against the concurrency cap. Run it before touching anything in the seams
  it covers: save → container filesystem → dev server → preview.

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
