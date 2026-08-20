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
    && mkdir -p /home/sandbox/app \
    && chown -R sandbox:0 /home/sandbox \
    && chmod -R g=u /home/sandbox

USER 1001:0
ENV HOME=/home/sandbox
WORKDIR /home/sandbox/app

# pip installs land in the user's home so they persist with the container.
ENV PATH=/home/sandbox/.local/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0

CMD ["sleep", "infinity"]
