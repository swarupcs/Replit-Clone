# Replit Clone

A browser IDE: create a project, edit files, run commands in a real shell, and
preview the result — with every project isolated in its own Docker container.

TypeScript throughout, in a pnpm workspace.

```
apps/web        React 19 + Vite 6 (TSX)      the IDE
apps/server     Express + socket.io + dockerode   API, editor sockets, terminals, preview proxy
packages/shared TypeScript contracts shared by both
images/         Sandbox base images (node, python)
```

`packages/shared` is the point of the monorepo: the socket event map, REST
response shapes, and the file-tree type are declared once and imported by both
sides, so a renamed event is a compile error rather than a silent no-op.

## Requirements

- Node 22+, pnpm 10+
- Docker (the server talks to the daemon to run project containers)

## Getting started

```bash
pnpm install
```

Build the sandbox images (once, and whenever `images/` changes):

```bash
pnpm images:build
```

Start Postgres:

```bash
pnpm db:up
```

Configure the server — copy `apps/server/.env.example` to `apps/server/.env` and
fill in the two JWT secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Apply the schema:

```bash
pnpm --filter @replit-clone/server exec prisma migrate deploy
```

Copy `apps/web/.env.example` to `apps/web/.env`, then run both apps:

```bash
pnpm dev
```

The IDE is at http://localhost:5273. Sign up, create a playground, and in its
terminal run the template's start command (shown when you create it) — for
React that is `npm install && npm run dev`. Then click **Show preview**.

## How it works

**Projects** live in `apps/server/projects/<projectId>` and are scaffolded by
copying a starter directory from `apps/server/templates`. Nothing is downloaded
and no command runs on the host.

**Containers**: one per project, created on demand from the template's image,
bind-mounting the project directory at `/home/sandbox/app`. Each is capped at
512 MB (swap disabled), 0.5 CPU, and 256 PIDs, runs as an unprivileged user with
all capabilities dropped and `no-new-privileges`, and sits on an isolated bridge
network. Containers stop after 20 minutes idle and restart on next use with the
files intact. Tune all of it through the environment.

**Terminals** are a `docker exec` into that container, streamed over a WebSocket
that shares the main HTTP port. The access token travels in the WebSocket
subprotocol, because a browser cannot set headers on an upgrade and a token in
the query string would land in access logs.

**Preview** is a reverse proxy at `/preview/:projectId/`, not a published port.
`PREVIEW_TARGET_MODE` decides how the server reaches the dev server:

- `container-ip` — dial the container on the sandbox network. Requires the
  server itself to be on that network, i.e. the compose deployment. Nothing is
  published to the host at all.
- `host-loopback` — publish the dev port on `127.0.0.1` and dial that. Needed
  when the server runs directly on a Windows or macOS host, where Docker Desktop
  gives the host no route to container IPs.

It defaults by detecting whether the server is itself containerised.

## Security model

The project id is **not** the access control. Every REST route and socket event
verifies a JWT and asserts the caller owns the project, and someone else's
project reports 404 rather than 403 so ids cannot be enumerated.

Client file operations name a path **relative to the project root**. The server
resolves it through a single choke point that rejects traversal, absolute paths,
Windows and drive-relative forms, and NUL bytes. Host paths never reach a
client — the file tree is built with relative paths only.

The server mounts the Docker socket, which is equivalent to host root. That is
only acceptable because authentication and path confinement sit in front of it.
**Do not expose this to the internet.**

## Deploying to a VM (LAN)

Create the sandbox network once:

```bash
docker network create replit-clone-sandbox
```

The web bundle bakes its backend URL at build time, so `HOST_IP` must be the
address browsers will actually use:

```bash
HOST_IP=192.168.0.50 POSTGRES_PASSWORD=... JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=... \
  docker compose -f docker-compose.prod.yml up -d --build
```

The IDE is then on port 80 and the API on 8080.

Note the `/data/projects` mount: it must be the **same path on the host and in
the server container**, because the server asks the host's Docker daemon to
bind-mount project directories and the daemon resolves that path on the host.

On 2 GB, budget roughly: Postgres ~200 MB, server ~150 MB, nginx ~10 MB, leaving
about three concurrent 512 MB projects. `MAX_CONCURRENT_CONTAINERS` returns a
clear "at capacity" error rather than letting Docker OOM-kill something.

## Templates

`react-vite`, `node-express`, `static-html`, `python-flask`. Each declares its
image, the port its dev server listens on, and its start command in
`apps/server/src/templates/registry.ts`; starter files live beside it in
`apps/server/templates/`.

Vite is configured with `base=/preview/<projectId>/` so its assets and HMR
socket resolve through the proxy. The other templates serve from the root and
the proxy strips the prefix instead — which means their assets must use relative
URLs.

## Scripts

```bash
pnpm dev            # run web + server
pnpm build          # build everything
pnpm typecheck      # typecheck every package
pnpm lint           # lint the web app
pnpm images:build   # build the sandbox images
pnpm db:up          # start Postgres
```
