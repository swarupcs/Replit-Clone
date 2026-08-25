# `@replit-clone/server`

Express + socket.io + dockerode. Serves the REST API, the editor socket, the
terminal WebSocket and the preview proxy from **one process on one port**.

Start here: [`CONTRIBUTING.md`](../../CONTRIBUTING.md) for setup and the
everyday commands, [`docs/SECURITY.md`](../../docs/SECURITY.md) for the trust
boundaries and the guard that enforces each one.

## Layout

```
src/routes/        Express routers; v1/ is the public API surface
src/controllers/   one function per route, validation at the edge (zod)
src/service/       the work itself — projects, access, collab, search, git
src/containers/    dockerode: lifecycle, runs, terminals, reconciliation
src/socketHandlers/editor socket events
src/terminal/      the terminal WebSocket gateway
src/templates/     the template registry; starter files live in templates/
src/utils/         projectPaths.ts is the path choke point — read it first
src/lib/           prisma, logger, metrics, mailer
prisma/            schema and migrations
```

## The three things to know before changing anything

**Every client path goes through `utils/projectPaths.ts`.** It is the single
place that rejects traversal, absolute paths, Windows and drive-relative forms,
and NUL bytes. A new file operation must resolve its path there rather than
joining it itself.

**Nothing is run through a shell.** Docker and git are executed as argv arrays
(`containers/execCapture.ts`, `service/gitService.ts`), so a filename cannot
become an argument or a command.

**Access level is checked per operation, not at connect.** A viewer is admitted
to the editor socket precisely so they can read; `service/projectAccessService.ts`
draws the line on each event, and an unreachable project answers 404 rather
than 403 so ids cannot be enumerated.

## Tests

```bash
pnpm --filter '@replit-clone/server' test
```

Tests that need a database skip unless `TEST_DATABASE_URL` points at a
throwaway Postgres with the migrations applied; CI always sets it.

No test needs a Docker daemon: the code that talks to one is exercised through
hand-built stand-ins typed as dockerode's `Container`, and the pure parts
(quoting, env signatures, run state, reconciliation) are tested directly.
`containerManager.ts`'s own Docker calls are the exception and are covered by
the end-to-end suite instead, which uses a real daemon.

## Configuration

`src/config/env.ts` is the whole surface, parsed and validated at boot; a
missing required variable fails the process rather than surfacing later as a
confusing runtime error. `.env.example` lists them with defaults.
