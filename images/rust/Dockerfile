# Base image for Rust project containers. plan.md §10.8.
FROM rust:1.83-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        nano \
        # ssh-keygen, for `git commit -S` -- git's SSH signing backend shells
        # out to it. plan.md §11.9.
        openssh-client \
        # sshd, so somebody can attach their own editor. plan.md §10.1 Route C.
        openssh-server \
        procps \
    && rm -rf /var/lib/apt/lists/*

# The container runs as whichever uid owns the bind-mounted project directory,
# because a bind mount keeps the HOST's ownership and masks any chown done
# here. Home to group 0 with the owner's bits mirrored means ANY uid paired
# with gid 0 gets a writable HOME -- which cargo's registry cache needs.
RUN useradd --create-home --shell /bin/bash --uid 1001 --gid 0 sandbox \
    && printf "PS1='\w \$ '\n" >> /home/sandbox/.bashrc \
    && mkdir -p /home/sandbox/app /home/sandbox/.cache \
    && chown -R sandbox:0 /home/sandbox \
    && chmod -R g=u /home/sandbox

# rust-analyzer, from rustup rather than a release tarball: the toolchain is
# already here and this keeps the analyzer and the compiler on the same
# version, which is the pairing that decides whether it understands the
# project's own syntax.
RUN rustup component add rust-analyzer rust-src clippy rustfmt \
    && ln -sf "$(rustup which rust-analyzer)" /usr/local/bin/rust-analyzer

USER 1001:0
ENV HOME=/home/sandbox \
    CARGO_HOME=/home/sandbox/.cache/cargo \
    # Target directory in the cache volume, not the project: a debug build is
    # hundreds of megabytes and rebuilding it on every container rebuild is the
    # same waste the node_modules cache exists to avoid.
    CARGO_TARGET_DIR=/home/sandbox/.cache/target
WORKDIR /home/sandbox/app

# Dev servers must listen on all interfaces to be reachable from the proxy.
ENV HOST=0.0.0.0

# Kept alive by the server; terminals attach via `docker exec`.
CMD ["sleep", "infinity"]
