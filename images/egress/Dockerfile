# The sandbox network's only way out.
#
# Needs `network.js` beside `proxy.mjs` before it builds. That file is the
# COMPILED address policy from `packages/shared`, copied in by
# `pnpm images:prepare`, and it is a build artifact rather than a checked-in
# file on purpose: the gateway and the server's own SSRF guard must agree on
# what "private" means, and the way to guarantee that is to ship them the same
# compiled module rather than two copies that agree on the day they are
# written.
#
#   pnpm images:build     # prepares, then builds all four
FROM node:22-bookworm-slim

# No package installs: the proxy has no dependencies, and the smaller the
# thing every sandbox byte passes through, the better.
RUN useradd --create-home --shell /usr/sbin/nologin --uid 1001 --gid 0 egress

WORKDIR /srv

# `network.js` is compiled ESM, and a bare .js file with no package.json
# beside it is parsed as CommonJS -- the import would fail at startup.
RUN printf '{"type":"module"}\n' > /srv/package.json

COPY network.js proxy.mjs ./

# Unprivileged, and holding nothing: this container has no mounts, no socket
# and no secrets. If it is compromised, what it grants is the network access
# it was already forwarding.
USER 1001:0

EXPOSE 3128
CMD ["node", "/srv/proxy.mjs"]
