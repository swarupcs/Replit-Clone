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
# uid 1000; we add our own so the name matches what the server execs as.
RUN useradd --create-home --shell /bin/bash --uid 1001 sandbox \
    && printf "PS1='\w \$ '\n" >> /home/sandbox/.bashrc \
    && mkdir -p /home/sandbox/app \
    && chown -R sandbox:sandbox /home/sandbox

USER sandbox
WORKDIR /home/sandbox/app

# Dev servers must listen on all interfaces to be reachable from the proxy.
ENV HOST=0.0.0.0

# Kept alive by the server; terminals attach via `docker exec`.
CMD ["sleep", "infinity"]
