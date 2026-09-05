# Reaching this from outside

plan.md §11.5. Everything before this document assumed the editor was on your
own machine or your own LAN. This is the smallest honest answer to "how do I
get to it from somewhere else", and the first half of it is a warning rather
than a step.

---

## Read this before the instructions

**What you are exposing is not a web app.** It is an editor that runs arbitrary
code in containers, on a host whose Docker socket is mounted into the server
process. `docker-compose.prod.yml` says *"do not expose this service to the
internet"* about exactly that, and this document does not make that sentence
false — it makes it possible to disobey deliberately instead of accidentally.
Anyone who gets a session here can run code on the machine, and the interesting
question is not whether they can read your source but what the container can
reach from where it sits.

So before the name exists:

- **Turn on `SANDBOX_EGRESS_FILTERED`.** Off, a project container can reach the
  host's LAN, the cloud instance-metadata endpoint that hands out credentials
  to anything that asks, and — in the compose deployment — this server's own
  API. `docker-compose.expose.yml` defaults it to `true` for that reason; the
  base file cannot, because turning it on breaks package installs until
  `pnpm images:build` has built the gateway image.
- **Turn on the second factor** (plan.md §11.6, Settings → Security). It is
  offered and not enforced, because on a laptop the network is the protection.
  Once there is a name on the internet, the network is not the protection.
- **Consider `SINGLE_USER_EMAIL`.** If this deployment is yours alone, single-
  user mode removes signup, password reset and email verification from the
  routing table entirely — not a guard each controller has to remember, but no
  handler at all.

If any of that reads as more than you want to take on, the tunnel below is a
better answer than the reverse proxy, and it is not a lesser one.

---

## Two routes, and the second is probably yours

### Route 1 — a tunnel

Tailscale, Cloudflare Tunnel, or similar. The machine makes an outbound
connection and is reachable through it; there is no inbound port, no
certificate to renew, and nothing to get wrong in a firewall.

**Take this if the machine is behind NAT**, which covers every laptop and most
home servers. It is not a compromise: with Tailscale the editor is reachable
only by devices you have added to your own network, which is a far stronger
answer than TLS plus a password, and it is the one that suits how this product
is actually used.

The application configuration is the same as Route 2 — three names, one
`COOKIE_DOMAIN` — because the app cannot tell the difference and does not care.
What changes is that your tunnel provider issues the names and the certificates
instead of Caddy. With Tailscale, `tailscale serve` gives you a
`*.ts.net` name with a real certificate; you still need **three** of them, or
`PREVIEW_PORT=0` and the trade it makes (see below).

### Route 2 — a reverse proxy with TLS

`docker-compose.expose.yml` and `deploy/Caddyfile` are a working version of
this. Caddy terminates TLS, obtains certificates from Let's Encrypt on its own,
and proxies to three services.

**This needs a real domain and inbound ports 80 and 443**, which is what makes
it the second choice rather than the first.

```bash
cp .env.expose.example .env    # then fill in DOMAIN and ACME_EMAIL
docker compose -f docker-compose.prod.yml -f docker-compose.expose.yml up -d --build
```

Point `ide`, `api` and `preview` at the host as A/AAAA records first — Caddy
asks for certificates on first boot and a name that does not resolve yet fails
that request.

---

## Why three names, and not one

This is the part the app has opinions about, and the part that fails silently
if you disagree with it quietly.

This platform serves three things that must not share an origin:

| | what it is | what it serves |
|---|---|---|
| `ide.` | the editor | this repository's own web bundle |
| `api.` | the API, terminal and socket | this repository's own server |
| `preview.` | project previews | **the user's code**, proxied from a container |

A preview is arbitrary code that somebody is running, including everything
their `npm install` pulled in. On the API's origin it would be same-origin with
the session cookie and could mint itself an access token. The editor's other
option — withholding `allow-same-origin` from the iframe — gives the frame an
opaque origin, and `<script type="module">` is always fetched in CORS mode, so
every module in the page is blocked: a client-rendered app shows a white pane
while a server-rendered one appears to work. `apps/server/src/previewServer.ts`
carries the long version.

Locally these three differ by **port** — 3000, 3101, 15273 — which is enough
for the origin boundary and costs nothing, because **cookies ignore ports**.
`localhost:3000` and `localhost:3101` share one cookie jar, so the preview
cookie the API sets arrives at the preview listener for free.

Behind a proxy they differ by **hostname**, and that free thing stops being
free.

### The one setting this document exists for

A cookie with no `Domain` attribute is **host-only**. Set by `api.example.com`,
it is never sent to `preview.example.com`. Nothing reports this: the browser
stores the cookie, declines to send it, and the server answers
`No preview session` for every preview forever. You are signed in, the editor
works, and the preview pane is empty.

```bash
COOKIE_DOMAIN=example.com
```

That puts `Domain=example.com` on the preview cookie so it reaches every name
under it. **The refresh cookie deliberately does not get it** — it is spent
only at the API's own `/api/v1/auth` path, so widening a session credential to
every sibling name would buy nothing.

The server refuses to start rather than let you discover this from the symptom.
Two different hostnames with no `COOKIE_DOMAIN`, a domain a browser would
reject, `SameSite=None` without `Secure` — each is an exit at boot with the
consequence spelled out. See `apps/server/src/config/exposure.ts`; the whole
matrix is in `exposure.test.ts`.

### Published sites go on a *second* domain

`DEPLOY_ORIGIN` cannot sit under `COOKIE_DOMAIN`, and the boot check refuses
that combination. A published site is somebody's code behind a name this
platform hands out; under the shared domain it would receive the preview cookie
on every `/preview` path and be able to overwrite it for the parent. Use a
second registrable domain — `sites.example.net`, not `sites.example.com`.

It also needs a **wildcard certificate**, since each site is at
`<label>.<that domain>`, which means the DNS-01 challenge, which means a Caddy
build carrying your DNS provider's plugin. `caddy:2-alpine` has none. The
commented block at the bottom of `deploy/Caddyfile` shows what to build.

Until you have arranged both, leave `DEPLOY_PORT=0`. The endpoints then refuse
rather than publishing to a listener nothing is proxying to.

---

## The rest of the settings, and why each one bites

| variable | value behind a proxy | what happens if you get it wrong |
|---|---|---|
| `WEB_ORIGIN` | `https://ide.$DOMAIN` | CORS refuses every API call, and the preview CSP's `frame-ancestors` refuses to be framed |
| `API_ORIGIN` | `https://api.$DOMAIN` | the OAuth `redirect_uri` stops matching what GitHub has registered |
| `PREVIEW_ORIGIN` | `https://preview.$DOMAIN` | nothing routes by it, but the boot check cannot see the whole picture without it |
| `COOKIE_DOMAIN` | `$DOMAIN` | every preview is refused, silently — see above |
| `COOKIE_SAME_SITE` | `lax` | `none` would send these cookies from any site on the internet that made a request here. Only use it if the editor is on a genuinely different registrable domain from the API |
| `COOKIE_SECURE` | `true` | over HTTPS `false` merely wastes the protection; over plain HTTP `true` makes the browser discard every cookie |
| `TRUSTED_PROXY_HOPS` | `1` | every rate limit keys on Caddy's address, so one account's failed sign-ins throttle everybody |
| `VITE_BACKEND_URL` | `https://api.$DOMAIN` | **baked at build time.** Changing it needs `--build`, not a restart |
| `VITE_PREVIEW_ORIGIN` | `https://preview.$DOMAIN` | same, and getting it wrong puts previews back on the API's origin |

`TRUSTED_PROXY_HOPS` has a second guard: the server logs a warning the first
time a request arrives carrying `X-Forwarded-For` while it is still 0. A
plain-HTTP proxy on a LAN is indistinguishable from no proxy at boot, so that
one waits for evidence rather than guessing.

---

## What is not covered

- **Nobody has run the Caddy route against a real domain.** The Caddyfile is
  validated by Caddy itself and the compose overlay resolves, and the cookie
  behaviour below was proven against a running server; ACME issuance, HTTP/3
  and the WebSocket upgrade through Caddy have not been exercised end to end.
- **The wildcard-certificate build for published sites** is described and not
  built.
- **No rate limit on the proxy itself.** `TRUSTED_PROXY_HOPS` makes the app's
  own limits key on the right address; it does not put anything in front of
  the connection.

### What was proven, and how

Against a real server on three hostnames (`api.rc.test`, `preview.rc.test`,
`ide.rc.test`) with a cookie jar implementing the same RFC 6265 rules a browser
does:

- Booting with two hostnames and no `COOKIE_DOMAIN` **exits**, naming the
  consequence.
- With `COOKIE_DOMAIN` set, the preview cookie is stored for `.rc.test` and the
  refresh cookie stays host-only to `api.rc.test` — the asymmetry is the point.
- A preview request to `preview.rc.test` carrying that jar gets past the auth
  gate; the same request without it is `401 No preview session`.
- Removing the `Domain` attribute reproduces the bug exactly: signed in, cookie
  stored for `api.rc.test` only, every preview `401`, nothing in the log.
