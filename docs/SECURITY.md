# Security model

This document is the map: where the trust boundaries are, and which mechanism
guards each one. It exists so a change that weakens one of these is recognisable
in review, and so an operator deploying this knows what the server does and
does not defend against.

The one-sentence version: **the server never trusts the client's paths,
commands, or identity — everything is resolved, validated, or re-authenticated
server-side, and user code only ever runs inside an unprivileged container.**

## Trust boundaries

```
browser ── API / editor socket ──► server process ── dockerode ──► project container
   │                                    │
   └── terminal WebSocket ──────────────┤
                                        ├── preview proxy ◄── browser (iframe)
                                        └── Postgres
```

Three things cross a boundary and therefore need a guard at every place they
appear: **paths** (where a request touches the host filesystem), **commands**
(what runs in a container), and **identity** (who is asking and what they may
do).

## Paths: one choke point

Every client-supplied path goes through `resolveInProject`
(`apps/server/src/utils/projectPaths.ts`). It rejects:

- traversal (`..`), absolute paths, and Windows drive-relative paths —
  `path.resolve` collapses them and the result is compared against the project
  root with a `root + sep` prefix check, so a sibling directory whose name
  merely starts the same does not pass;
- NUL bytes, which truncate paths inside libuv;
- Windows separators, normalised before resolution.

A `projectId` is both a path segment and a container name, so it is
UUID-validated before it reaches either (`assertValidProjectId`). Nothing else
in the server joins a client string onto a host path.

## Commands: argv arrays, never a shell

- Docker exec (`containers/execCapture.ts`) and git (`service/gitService.ts`)
  pass argv arrays. There is no shell between the server and the command, so
  there is no injection surface in the usual sense.
- Project search is pure Node in a worker thread, not a `rg`/`grep` subprocess
  — a user-supplied pattern never reaches a shell, and a pathological regex
  costs one worker for five seconds rather than the whole server
  (`service/searchService.ts`).
- Replacements (search & replace) run under the same worker deadline with caps
  on files rewritten and bytes added.

## Identity: short-lived tokens, checked per action

- Passwords: argon2. Sessions: JWT access tokens plus rotating, hashed refresh
  tokens with replay detection (`service/refreshTokenService.ts`) — presenting
  a spent refresh token revokes its whole family.
- Access level (`viewer` / `editor` / `owner`) is a rank, and every operation
  states the level it needs. A project the caller cannot reach is 404, not
  403, so the API cannot be used to discover which ids exist.
- Sockets re-check at call time, not connect time: a viewer may connect to
  read, and every write-shaped event refuses them (`socketHandlers/editorHandler.ts`).
- Access revocation is watched live (`service/accessWatch.ts`): removing or
  demoting a collaborator tears down their editor sockets and terminal
  WebSocket (close code 4403) without waiting for a reconnect.
- Share links are 32-byte bearer secrets, but an EDITOR link is still a named
  grant — redeeming requires a signed-in session and inserts a visible,
  demotable collaborator row. Revoking a link invalidates it for the future;
  people already redeemed keep (and can lose) their access individually.

## Execution: containers

- Every project runs in its own Docker container from an unprivileged base
  image (`images/`): a non-root `sandbox` user, on a dedicated sandbox bridge
  network (`replit-clone-sandbox`) separate from the host's default bridge —
  no ports are published to the host in the default mode; the preview proxy is
  the only way in. Each preview response carries the platform's CSP
  (`frame-ancestors` limited to the editor, `base-uri 'self'`,
  `object-src 'none'`), and the sandbox's own CSP/X-Frame-Options headers are
  dropped — defense in depth against a compromised sandbox serving hostile
  markup into the IDE's iframe.
- Containers are capped: memory, CPUs, a global concurrency limit, a
  per-user limit, and an idle reaper (`containers/containerManager.ts`).
- The terminal is a shell *inside that container*, reached by a WebSocket
  whose token travels in the subprotocol list (never the query string, which
  lands in access logs). It requires editor access and is closed on
  revocation.
- Uploads and downloads are bounded (25 MB per file), quota-checked, path-
  confined, and downloads are forced `attachment` with `nosniff` so the API
  origin never renders user content.

## Limits and abuse

- Auth routes are rate limited; socket events that cost IO or a Docker round
  trip carry a per-socket budget (search, replace, reads, stats).
- File sizes are capped for open, save, upload, and search; the AI assistant
  has a per-user hourly quota.
- `TRUSTED_PROXY_HOPS` opts into exactly N proxy hops rather than a blanket
  `trust proxy`, so client IPs used for rate limiting cannot be spoofed by
  accident of configuration.

## Reporting

Found something? Please report it privately by opening a GitHub security
advisory on the repository (Security → Report a vulnerability) rather than a
public issue. Include reproduction steps and the affected boundary from the
list above if you can; reports are welcome either way.
