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
