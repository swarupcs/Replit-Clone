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

RUN useradd --create-home --shell /bin/bash --uid 1001 sandbox \
    && printf "PS1='\w \$ '\n" >> /home/sandbox/.bashrc \
    && mkdir -p /home/sandbox/app \
    && chown -R sandbox:sandbox /home/sandbox

USER sandbox
WORKDIR /home/sandbox/app

# pip installs land in the user's home so they persist with the container.
ENV PATH=/home/sandbox/.local/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0

CMD ["sleep", "infinity"]
