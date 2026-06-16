# syntax=docker/dockerfile:1
#
# Production image for the React/Vite web console. Build context is the repo
# ROOT (the npm workspace lives at the root: clients/ts + web). Served by a
# rootless nginx on :8080 so it drops into Kubernetes with a non-root SCC and a
# readonly-friendly footprint.

# Base images pinned to their multi-arch index digest (Renovate-maintained).
FROM node:24-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS builder
ARG SOURCE_DATE_EPOCH
WORKDIR /workspace

# Install against the committed lockfile only — reproducible, offline-friendly.
COPY package.json package-lock.json ./
COPY clients/ts/package.json ./clients/ts/package.json
COPY web/package.json ./web/package.json
RUN npm ci --workspaces --include-workspace-root

# Bring in the sources the build needs (api-client-ts is consumed as TS source).
COPY clients/ts ./clients/ts
COPY web ./web

# tsc -b && vite build → web/dist
RUN npm run build --workspace @maintenance/web-console

# ---- runtime ---------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:37f356a5eba5d187365b4f59cd6cc29f1f922ad18146d554b576a80983377e6a AS runtime

# Stopgap until Renovate bumps the base digest: patch the OpenSSL libraries the
# pinned base ships vulnerable (CVE-2026-45447 in libssl3/libcrypto3, fixed in
# openssl 3.5.7-r0) so the Trivy HIGH/CRITICAL gate passes. apk needs root; the
# image otherwise runs rootless as uid 101, which we restore immediately.
USER root
RUN apk upgrade --no-cache libssl3 libcrypto3
USER 101

# Rootless image already runs as uid 101 and listens on 8080.
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /workspace/web/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["sh", "-c", "wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1"]
