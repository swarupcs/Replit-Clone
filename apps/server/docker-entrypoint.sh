#!/bin/sh
# Applies pending migrations, then starts the server.
#
# Every compose file used to start the server straight from `node dist/index.js`
# and nothing ever ran `prisma migrate deploy`. A first boot against an empty
# database came up clean and then failed every query at runtime, and the README
# covered it in prose for one deployment path out of three.
#
# `migrate deploy` only applies migrations that have not been applied yet, so
# running it on every boot is idempotent — and a restart is exactly when a new
# one needs picking up.
set -e

echo "Applying database migrations..."
pnpm exec prisma migrate deploy

echo "Starting server..."
exec node dist/index.js
