FROM node:22-bookworm-slim AS build

RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile --filter @replit-clone/web... --filter @replit-clone/shared

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web

# Baked into the bundle at build time, so it must be the URL browsers will use.
ARG VITE_BACKEND_URL=http://localhost:8080
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL

# The origin previews are served from, which must NOT be the API's. Baked in
# the same way, and for the same reason.
ARG VITE_PREVIEW_ORIGIN=http://localhost:8081
ENV VITE_PREVIEW_ORIGIN=$VITE_PREVIEW_ORIGIN

RUN pnpm --filter @replit-clone/shared build \
    && pnpm --filter @replit-clone/web build

FROM nginx:1.27-alpine AS runtime

COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
