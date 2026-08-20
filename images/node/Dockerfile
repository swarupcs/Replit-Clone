# Base image for Node/Vite project containers.
FROM node:22-bookworm-slim

# Pinned, minimal tooling. The previous image ran `apt upgrade` at build time,
# which made builds non-reproducible and slow for no benefit.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        nano \
        procps \
    && rm -rf /var/lib/apt/lists/*

# Unprivileged user owning the workspace. The node image ships a `node` user at
# uid 1000; we add our own so the default uid is predictable.
# The container runs as whichever uid owns the bind-mounted project directory,
# because a bind mount keeps the HOST's ownership and masks any chown done here.
# Giving the home to group 0 and mirroring the owner's bits onto the group means
# ANY uid paired with gid 0 gets a writable HOME -- which is what npm, pip and
# the shell all need.
RUN useradd --create-home --shell /bin/bash --uid 1001 --gid 0 sandbox \
    && printf "PS1='\w \$ '\n" >> /home/sandbox/.bashrc \
    && mkdir -p /home/sandbox/app \
    && chown -R sandbox:0 /home/sandbox \
    && chmod -R g=u /home/sandbox

USER 1001:0
ENV HOME=/home/sandbox
WORKDIR /home/sandbox/app

# Dev servers must listen on all interfaces to be reachable from the proxy.
ENV HOST=0.0.0.0

# Kept alive by the server; terminals attach via `docker exec`.
CMD ["sleep", "infinity"]
