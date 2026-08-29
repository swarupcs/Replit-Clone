# Base image for Go project containers.
FROM golang:1.23-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        nano \
        procps \
    && rm -rf /var/lib/apt/lists/*

# The container runs as whichever uid owns the bind-mounted project directory,
# because a bind mount keeps the HOST's ownership and masks any chown done here.
# Giving the home to group 0 and mirroring the owner's bits onto the group means
# ANY uid paired with gid 0 gets a writable HOME -- which is what the Go module
# cache and the shell both need.
RUN useradd --create-home --shell /bin/bash --uid 1001 --gid 0 sandbox \
    && printf "PS1='\w \$ '\n" >> /home/sandbox/.bashrc \
    && mkdir -p /home/sandbox/app /home/sandbox/.cache \
    && chown -R sandbox:0 /home/sandbox \
    && chmod -R g=u /home/sandbox

# The language server, installed into the image rather than on demand.
#
# `go install` as the sandbox user would write into a GOPATH under a home
# that a bind mount can mask, and would need egress to proxy.golang.org on a
# network that may be filtered -- so it is built here, as root, into a
# directory already on PATH. GOFLAGS is cleared for this one command because
# the image sets -buildvcs=false for user projects and `go install` rejects
# it.
RUN GOFLAGS= GOPATH=/tmp/gopath GOCACHE=/tmp/gocache \
    go install golang.org/x/tools/gopls@v0.16.2 \
    && mv /tmp/gopath/bin/gopls /usr/local/bin/gopls \
    && chmod 0755 /usr/local/bin/gopls \
    && rm -rf /tmp/gopath /tmp/gocache

USER 1001:0
ENV HOME=/home/sandbox \
    GOPATH=/home/sandbox/.cache/go \
    GOCACHE=/home/sandbox/.cache/go-build \
    GOFLAGS=-buildvcs=false
WORKDIR /home/sandbox/app

# Dev servers must listen on all interfaces to be reachable from the proxy.
ENV HOST=0.0.0.0

# Kept alive by the server; terminals attach via `docker exec`.
CMD ["sleep", "infinity"]
