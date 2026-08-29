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
- A git argument that a user chose — a branch, a remote, a path — is checked
  before it is passed, because argv arrays stop a shell but not git's own
  option parsing. A leading dash is rejected everywhere (`--upload-pack=` is an
  argument, not a filename), branch names go through git's own
  `check-ref-format`, and the `--` separator is placed where git reads it as
  "no pathspecs follow" rather than "what follows is a path".

## Git remotes: a credential only ever reaches its owner's own container

Listing remotes, adding and removing one, fetching and pulling need no
credential at all, and are open to any editor.

**Pushing does**, and a credential is only ever as private as the container it
is spent in. Every collaborator on a project works in the **same container**,
so anything given to git inside a shared one — in the environment, in a URL, in
a credential helper, or on a command line — is readable by whatever code anyone
with access runs there. Handing a push token to a shared container would be a
way for a collaborator to walk off with the owner's account.

So pushing from the editor is allowed on exactly one condition: the project has
no collaborators **and** no outstanding share link, which makes the container
the owner's alone. Anything else is refused, and the refusal says where pushing
still works — the project's own terminal, where the secret is typed into the
user's own session and never passes through this server. An unredeemed link
counts as sharing: it is an invitation that can be accepted while a push is in
flight (`isSoleOccupant`, `controllers/gitController.ts`).

The token travels to git in the **exec's environment rather than its
arguments** — process arguments are world-readable through `/proc`, a process's
environment is not — is never written into the repository's config or a remote's
URL, and is redacted from anything git says on the way back (`pushRemote`,
`redactToken`, `service/gitService.ts`).

It reaches the server one of two ways. **Pasted for one call**, in which case it
is held nowhere at all. Or from a **connected GitHub account**, in which case it
is encrypted at rest with AES-256-GCM under `SECRET_ENCRYPTION_KEY`
(`lib/secretBox.ts`) — a token cannot be hashed the way a password is, because
the point is to spend it later, so a leaked dump must hand over ciphertext and
nothing more. Connecting is a **separate consent from signing in**: signing in
asks for `read:user user:email`, and nobody is made to grant write access to
their private repositories in order to log in. Disconnecting deletes the row
rather than flagging it, and a row that can no longer be decrypted — after a key
rotation — is dropped rather than left to fail on every later call. The token is
never sent to a browser: `githubConnection` describes a connection and
`githubToken` hands over the credential, deliberately two functions so a caller
that only needs the login cannot reach the secret by accident.

The sole-occupant rule is what governs spending it either way. A stored token
makes pushing less tedious; it does not make a shared container private.

**A stored token is only ever offered to GitHub.** git's credential helper
answers whatever host git asks it about — it is handed the request on stdin and
prints a password regardless — so a push to a remote pointing elsewhere would
hand somebody's GitHub token to that host. Remotes are added at *editor* level
and may name any https host, while pushing is the owner's; those do not overlap
today, but they only have to once (a collaborator adds a mirror and is removed;
a README says "add this remote and push"). So the fallback checks the named
remote is a GitHub one first, and refuses otherwise. A **pasted** token is
unaffected: choosing to give a credential to a particular remote is exactly what
typing one in means.

Pushing is also the owner's alone at the access-control layer, not merely by
the sharing check: it spends the owner's credential, so an editor cannot ask
for it.

**Importing a repository** clones inside the project's own container, through
the same exec path every other git call uses — never on the host. A URL from a
browser driving a network fetch on the host is what that boundary exists to
prevent. The URL is built server-side from a name the GitHub API returned rather
than taken as a string from the request, which removes the transport question
below instead of answering it; submodules are not fetched, since they can point
anywhere including at a local path; and a repository too large for the disk
quota is refused before anything is downloaded (`service/repoImportService.ts`).
A newly imported project has no collaborators and no share link, so the rule
above holds by construction.

Remote URLs are checked against an allow-list of transports rather than a
deny-list, because `ext::` runs the rest of the string as a **command** —
`git remote add x "ext::sh -c ..."` is remote code execution the moment
anything fetches. `file://` is refused too: it would reach whatever the server
can see rather than anything on the network
(`isUsableRemoteUrl`, `service/gitService.ts`).

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
- Containers are capped: memory, CPUs, PIDs, disk, a global concurrency limit,
  a per-user limit, and an idle reaper (`containers/containerManager.ts`).
- **Egress** is filtered where the deployment turns it on
  (`SANDBOX_EGRESS_FILTERED`). The sandbox bridge is then created
  `Internal: true` — Docker adds no route off it and no NAT — and a single
  unprivileged gateway container (`images/egress`) attached to both that
  network and an ordinary one is the only way out. It refuses any destination
  resolving to a private address, using the same rule as the SSRF guard above
  (`packages/shared/src/network.ts`, so there is one definition rather than
  two that agree on the day they were written), and it refuses ports outside
  80/443/9418. An optional domain allowlist is a ceiling on top.

  The proxy variables handed to project containers are a convenience, not the
  control: code that respects `HTTPS_PROXY` gets a working `npm install`, and
  code that ignores it — which is what hostile code would do — finds no route.
  The policy is enforced by the topology.

  Without it, a project container reaches the internet (which it must, to
  install packages) and with it the host's LAN, the cloud instance metadata
  endpoint that hands credentials to anything that asks, and in the compose
  deployment this server's own API. It is off by default only so that an
  existing deployment does not lose package installs on upgrade; a deployment
  running untrusted code should turn it on. Turning it on when the network
  already exists is refused at boot rather than ignored, because Docker cannot
  change the flag on an existing network and a server that believes it is
  filtering when it is not is worse than one that will not start. Turning it
  back *off* while the internal network survives is refused for the same
  reason, from the other side: package installs fail and previews go dark.

  It is also incompatible with `PREVIEW_TARGET_MODE=host-loopback`, and that
  is likewise refused at boot. Docker publishes a container port by adding a
  DNAT rule on the host and does not do so for a container on an internal
  network — it accepts the request and silently produces no binding — so the
  preview proxy, which dials the published port on 127.0.0.1 in that mode, has
  nothing to reach. Every preview then reports that nothing is running while
  the dev server is demonstrably up, which reads as a bug in the project
  rather than as a network flag two layers away. Filtering therefore belongs
  to deployments where the server shares the sandbox network — the compose
  setup — and not to a server run directly on a developer's machine.
- **A published service is a container the public can reach**, and is treated
  as one. The templates that serve from a process are published by running a
  container of their own (`containers/deployContainer.ts`) with the public
  origin proxying to it. It gets the same confinement a project container
  does — `CapDrop: ALL`, `no-new-privileges`, a memory and PID cap, the sandbox
  network, and the egress control when that is on — plus three differences that
  follow from being reachable by strangers:

  - It runs a **copy** of the tree, never the project's working directory. A
    published address that changed under its visitors every time its author
    saved a file would not be a deployment. The copy goes through the same
    symlink-refusing, budget-checking `copyTree` the static path uses, and
    additionally leaves `node_modules` and `.git` behind — the latter because a
    project's whole history, including anything committed and later removed, has
    no business in a directory whose purpose is to be reachable.
  - It publishes **no host port** except in host-loopback mode, where it binds
    127.0.0.1 only. The deploy origin is the sole way in.
  - It has a **budget of its own** (`MAX_DEPLOYED_SERVICES`) rather than a share
    of `MAX_CONCURRENT_CONTAINERS`. Counting always-on containers against the
    interactive limit means enough publishing makes the editor unopenable, which
    is a denial of service reachable by ordinary use.

  The public origin proxies these without parsing a cookie, as it serves static
  sites without parsing one: there is no identity on that origin, and an app's
  own cookies belong to its own subdomain.
- The terminal is a shell *inside that container*, reached by a WebSocket
  whose token travels in the subprotocol list (never the query string, which
  lands in access logs). It requires editor access and is closed on
  revocation.
- **The editor origin refuses to be framed.** `frame-ancestors 'none'` plus
  `X-Frame-Options: DENY`, served by Vite in development and nginx in the
  image, from one set of values with a test that fails when the two drift. A
  page able to frame the IDE would be showing a real editor carrying the
  reader's real session under markup of its own choosing. `/embed/` is the one
  exception and drops the framing rule rather than loosening it, because being
  framed by pages this platform will never see is the entire feature.

  Deliberately not a full policy: no `default-src` or `script-src`, because
  Monaco loads workers from blob: URLs and its TypeScript worker needs eval —
  a strict script policy there is a white editor rather than a secure one.
- **The API origin** carries `default-src 'none'; frame-ancestors 'none';
  base-uri 'none'; form-action 'none'`, which is safe there precisely because
  nothing it serves is a document. Previews are exempt, and only when
  `PREVIEW_PORT=0` actually puts them on this origin — the exemption used to
  be the whole server.
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
