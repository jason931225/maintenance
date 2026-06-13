#!/usr/bin/env bash
# DEV-ONLY: bring up the local full stack with auth wired so you can actually sign in.
# Generates a persistent ES256 keypair under ops/.dev-secrets/ (gitignored) and
# exports it for compose to inject. NOT for production (prod injects real secrets
# per docs/release/SECRETS.md). After this, run `npm run web:dev` and open
# http://localhost:5173 — first sign-in uses the one-time code "coss0000".
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p ops/.dev-secrets
if [ ! -f ops/.dev-secrets/jwt-private.pem ]; then
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ops/.dev-secrets/jwt-private.pem
  openssl pkey -in ops/.dev-secrets/jwt-private.pem -pubout -out ops/.dev-secrets/jwt-public.pem
fi
export MNT_JWT_PRIVATE_KEY_PEM="$(cat ops/.dev-secrets/jwt-private.pem)"
export MNT_JWT_PUBLIC_KEY_PEM="$(cat ops/.dev-secrets/jwt-public.pem)"
export MNT_POSTGRES_PORT="${MNT_POSTGRES_PORT:-5433}"
docker-compose -f ops/compose.yml -f ops/compose.dev.yml up -d --build app
docker-compose -f ops/compose.yml -f ops/compose.dev.yml up -d
echo "Stack up. Apply migrations if needed, then: npm run web:dev  ->  http://localhost:5173 (first sign-in code: coss0000)"
