# Base image for Python project containers.
FROM python:3.13-slim-bookworm

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
# ANY uid paired with gid 0 gets a writable HOME -- which is what npm, pip and
# the shell all need.
RUN useradd --create-home --shell /bin/bash --uid 1001 --gid 0 sandbox \
    && printf "PS1='\w \$ '\n" >> /home/sandbox/.bashrc \
    && mkdir -p /home/sandbox/app /home/sandbox/.cache \
    && chown -R sandbox:0 /home/sandbox \
    && chmod -R g=u /home/sandbox

# The language server, installed into the image rather than on demand.
#
# It has to be here, not in the user's home: a `pip install --user` at
# start-up would be paid on every cold container, would need egress on a
# network that may be filtered, and would race the first
# `textDocument/didOpen`. Installed system-wide and BEFORE the USER switch,
# so a container running as any uid paired with gid 0 -- which is how a bind
# mount's ownership is honoured -- can execute it.
#
# --no-cache-dir because a wheel cache baked into an image is dead weight in
# every layer that follows it.
# The extras are not optional in practice. A bare `python-lsp-server` starts,
# initializes, and publishes an EMPTY diagnostics list for a file with a
# syntax error in it -- the checkers live in separate packages that the base
# install does not pull. Measured: without pyflakes the probe below reported
# one publishDiagnostics notification containing nothing.
#
# pyflakes is what makes undefined names and unused imports appear;
# pycodestyle is the style half. Both are small and pure Python. jedi arrives
# as a dependency and is what completion and hover come from.
RUN pip install --no-cache-dir     "python-lsp-server==1.12.0"     "pyflakes==3.2.0"     "pycodestyle==2.12.1"

USER 1001:0
ENV HOME=/home/sandbox \
    PIP_CACHE_DIR=/home/sandbox/.cache/pip
WORKDIR /home/sandbox/app

# pip installs land in the user's home so they persist with the container.
ENV PATH=/home/sandbox/.local/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0

CMD ["sleep", "infinity"]
