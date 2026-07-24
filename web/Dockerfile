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
RUN npm run check:production-dev-auth-absence --workspace @console/web

# ---- runtime ---------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:de3e40ec8b7debd7194fc798d4bbfb102c7f8b012b2c73032816b5f72393acdd AS runtime

# Stopgap until Renovate bumps the base digest: patch the OS libraries the pinned
# base ships vulnerable so the Trivy HIGH/CRITICAL gate passes — CVE-2026-45447 in
# libssl3/libcrypto3 (openssl 3.5.7-r0), CVE-2026-45186 in libexpat (2.8.1-r0),
# CVE-2026-33630 in c-ares (1.34.8-r0), and CVE-2026-5773/CVE-2026-6276 in
# curl/libcurl (8.19.0-r0).
# apk needs root; the image otherwise runs rootless as uid 101, restored below.
USER root
RUN apk upgrade --no-cache libssl3 libcrypto3 libexpat c-ares curl
USER 101

# Rootless image already runs as uid 101 and listens on 8080.
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /workspace/web/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["sh", "-c", "wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1"]
