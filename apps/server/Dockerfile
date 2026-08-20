# Build stage: compiles the workspace with dev dependencies present.
FROM node:22-bookworm-slim AS build

RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/

RUN pnpm install --frozen-lockfile --filter @replit-clone/server... --filter @replit-clone/shared

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server

RUN pnpm --filter @replit-clone/shared build \
    && pnpm --filter @replit-clone/server exec prisma generate \
    && pnpm --filter @replit-clone/server build

# Runtime stage: production dependencies only.
FROM node:22-bookworm-slim AS runtime

RUN corepack enable
WORKDIR /app

ENV NODE_ENV=production

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/

RUN pnpm install --frozen-lockfile --prod \
      --filter @replit-clone/server... --filter @replit-clone/shared \
    && pnpm store prune

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/src/generated apps/server/src/generated
COPY apps/server/prisma apps/server/prisma
COPY apps/server/prisma.config.ts apps/server/
# Starter files are read at runtime when a project is scaffolded.
COPY apps/server/templates apps/server/templates
COPY apps/server/docker-entrypoint.sh apps/server/

WORKDIR /app/apps/server

# Runs as root because it needs the Docker socket. That socket is equivalent to
# host root, which is why auth and path confinement sit in front of it.
#
# The entrypoint applies pending migrations before starting. Nothing used to,
# so a first boot against an empty database came up and then failed every
# query.
ENTRYPOINT ["./docker-entrypoint.sh"]
