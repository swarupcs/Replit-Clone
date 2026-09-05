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
        # ssh-keygen, and only for `git commit -S`: git's SSH signing backend
        # shells out to it. Without this, an account with signing turned on
        # gets "gpg failed to sign the data" on every commit -- a message that
        # names the wrong tool and the wrong problem. plan.md §11.9.
        openssh-client \
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
    && mkdir -p /home/sandbox/app /home/sandbox/.cache \
    && chown -R sandbox:0 /home/sandbox \
    && chmod -R g=u /home/sandbox

# Preinstalled so the static template starts offline and instantly, rather than
# re-fetching it through `npx --yes` on every run.
RUN npm install --global serve@14 \
    && npm cache clean --force

# pnpm and yarn, via the corepack that ships with Node.
#
# Not a convenience. `warmStart` already fingerprints `pnpm-lock.yaml` and
# `yarn.lock` and knows how to skip their installs, and the import path now
# emits `pnpm install` for a repository whose lockfile says pnpm -- all of which
# fails with command-not-found unless the binaries are here. The ENV below
# already points PNPM_HOME and YARN_CACHE_FOLDER at the cache volume, so this
# image was written expecting them; they were simply never installed.
#
# `corepack prepare` pins and downloads them at BUILD time, so a project's first
# install does not also pay to fetch its package manager -- and so a sandbox
# whose egress allowlist does not include corepack's CDN still works.
RUN corepack enable \
    && corepack prepare pnpm@9.15.4 --activate \
    && corepack prepare yarn@4.6.0 --activate

USER 1001:0
ENV HOME=/home/sandbox \
    NPM_CONFIG_CACHE=/home/sandbox/.cache/npm \
    YARN_CACHE_FOLDER=/home/sandbox/.cache/yarn \
    PNPM_HOME=/home/sandbox/.cache/pnpm
WORKDIR /home/sandbox/app

# Dev servers must listen on all interfaces to be reachable from the proxy.
ENV HOST=0.0.0.0

# Kept alive by the server; terminals attach via `docker exec`.
CMD ["sleep", "infinity"]
