# Base image for C and C++ project containers. plan.md §10.8.
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        # clangd IS the language server. Installed from Debian rather than a
        # release tarball so it matches the headers and the standard library
        # this image actually has -- an analyzer that disagrees with the
        # compiler about where <vector> lives is worse than none.
        clangd \
        clang \
        cmake \
        curl \
        git \
        nano \
        openssh-client \
        openssh-server \
        procps \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/clangd /usr/local/bin/clangd

RUN useradd --create-home --shell /bin/bash --uid 1001 --gid 0 sandbox \
    && printf "PS1='\w \$ '\n" >> /home/sandbox/.bashrc \
    && mkdir -p /home/sandbox/app /home/sandbox/.cache \
    && chown -R sandbox:0 /home/sandbox \
    && chmod -R g=u /home/sandbox

USER 1001:0
ENV HOME=/home/sandbox
WORKDIR /home/sandbox/app
ENV HOST=0.0.0.0
CMD ["sleep", "infinity"]
